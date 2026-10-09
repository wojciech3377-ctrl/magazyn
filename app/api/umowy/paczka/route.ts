import type { NextRequest } from "next/server";
import { zipSync } from "fflate";
import { createClient } from "@/lib/supabase/server";
import { contractPdf } from "@/lib/contracts/sign";
import { errorMessage } from "@/lib/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const UUID = /^[0-9a-f-]{36}$/i;

function safeName(s: string) {
  return s.replace(/[\\/:*?"<>|#]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 90);
}

/**
 * Paczka umów (ZIP) dla zaznaczonych zamówień: skany i podpisane umowy z szablonu
 * przypięte do sprzedanych sztuk albo wygenerowane dla linii zamówienia.
 */
export async function GET(req: NextRequest) {
  const db = await createClient();
  const { data: auth } = await db.auth.getClaims();
  if (!auth?.claims?.sub) return new Response("unauthorized", { status: 401 });
  const { data: profile } = await db.from("profiles").select("can_see_prices, active").eq("id", auth.claims.sub).single();
  if (!profile?.active) return new Response("forbidden", { status: 403 });

  const orderIds = req.nextUrl.searchParams.getAll("zamowienia").flatMap((x) => x.split(",")).filter((x) => UUID.test(x)).slice(0, 200);
  if (!orderIds.length) return new Response("Zaznacz zamówienia.", { status: 400 });

  const [{ data: orders }, { data: sales }] = await Promise.all([
    db.from("orders").select("id, number").in("id", orderIds),
    db.from("sales").select("id, order_id, unit:units(contract_id)").in("order_id", orderIds),
  ]);
  const numberOf = new Map((orders ?? []).map((o) => [o.id as string, o.number as string]));
  const saleIds = (sales ?? []).map((s) => s.id);
  const { data: bySale } = saleIds.length
    ? await db.from("contracts").select("id, sale_id").in("sale_id", saleIds).eq("status", "accepted")
    : { data: [] };

  // Umowa → pierwsze zamówienie, w którym występuje (ta sama umowa może obejmować kilka zamówień).
  const orderOfContract = new Map<string, string>();
  for (const s of sales ?? []) {
    const cid = (s.unit as unknown as { contract_id: string | null } | null)?.contract_id;
    if (cid && !orderOfContract.has(cid)) orderOfContract.set(cid, s.order_id as string);
  }
  for (const c of bySale ?? []) {
    const s = sales?.find((x) => x.id === c.sale_id);
    if (s && !orderOfContract.has(c.id)) orderOfContract.set(c.id, s.order_id as string);
  }
  if (!orderOfContract.size) return new Response("Zaznaczone zamówienia nie mają jeszcze umów.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });

  const { data: contracts } = await db.from("contracts").select("*").in("id", [...orderOfContract.keys()]);
  const files: Record<string, Uint8Array> = {};
  const missing: string[] = [];
  const used = new Set<string>();
  for (const c of contracts ?? []) {
    const nr = numberOf.get(orderOfContract.get(c.id)!) ?? "";
    const base = safeName(`${nr} - ${c.counterparty ?? "umowa"}${c.number ? ` - umowa ${c.number}` : ""}`);
    try {
      let bytes: Uint8Array | null = null;
      let ext = "pdf";
      if (c.file_path) {
        const { data: blob, error } = await db.storage.from("contracts").download(c.file_path);
        if (error || !blob) throw error ?? new Error("brak pliku");
        bytes = new Uint8Array(await blob.arrayBuffer());
        ext = (c.file_path.split(".").pop() ?? "pdf").toLowerCase().slice(0, 5);
      } else if (c.template) {
        if (!profile.can_see_prices) {
          missing.push(`${base}: umowa z cenami zakupu – brak dostępu do cen`);
          continue;
        }
        if (c.status !== "accepted") {
          missing.push(`${base}: umowa jeszcze niezatwierdzona`);
          continue;
        }
        bytes = await contractPdf(db, c);
      }
      if (!bytes) {
        missing.push(`${base}: brak pliku umowy`);
        continue;
      }
      let name = `${base}.${ext}`;
      for (let i = 2; used.has(name); i++) name = `${base} (${i}).${ext}`;
      used.add(name);
      files[name] = bytes;
    } catch (e) {
      missing.push(`${base}: ${errorMessage(e)}`);
    }
  }
  if (missing.length) files["BRAKUJACE.txt"] = new TextEncoder().encode(`Nie dołączono:\n${missing.join("\n")}\n`);
  if (!Object.keys(files).length) return new Response("Brak plików umów do pobrania.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });

  const zip = zipSync(files, { level: 6 });
  const stamp = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw" }).format(new Date());
  return new Response(Buffer.from(zip), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="umowy-${stamp}.zip"`,
      "Cache-Control": "private, no-store",
    },
  });
}
