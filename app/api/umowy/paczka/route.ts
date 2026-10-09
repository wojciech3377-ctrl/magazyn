import type { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { contractsZip, zipResponse } from "@/lib/contracts/zip";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const UUID = /^[0-9a-f-]{36}$/i;

/** Paczka umów (ZIP) dla zaznaczonych zamówień: umowy sprzedanych sztuk i umowy wygenerowane do linii zamówienia. */
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
  const { data: bySale } = saleIds.length ? await db.from("contracts").select("id, sale_id").in("sale_id", saleIds).eq("status", "accepted") : { data: [] };
  const entries: { contractId: string; prefix: string }[] = [];
  for (const s of sales ?? []) {
    const cid = (s.unit as unknown as { contract_id: string | null } | null)?.contract_id;
    if (cid) entries.push({ contractId: cid, prefix: numberOf.get(s.order_id as string) ?? "" });
  }
  for (const c of bySale ?? []) {
    const s = sales?.find((x) => x.id === c.sale_id);
    if (s) entries.push({ contractId: c.id, prefix: numberOf.get(s.order_id as string) ?? "" });
  }
  const zip = await contractsZip(db, entries, !!profile.can_see_prices);
  if (!zip) return new Response("Zaznaczone zamówienia nie mają jeszcze umów.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  const stamp = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw" }).format(new Date());
  return zipResponse(zip, `umowy-${stamp}.zip`);
}
