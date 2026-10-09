import type { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { loadJpkLines, loadJpkLinesByKeys } from "@/lib/jpk";
import { monthRange } from "@/lib/month";
import { jpkWorkbook } from "@/lib/jpk-xlsx";
import { contractsZip, zipResponse } from "@/lib/contracts/zip";
import { errorMessage } from "@/lib/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const KEY = /^(o:[0-9a-f-]{36}:\d{1,3}:\d{1,3}|[pi]:[0-9a-f-]{36})$/i;

/**
 * Eksport zaznaczonych linii JPK (POST z formularza): „xlsx” = plik JPK w Excelu (tylko z dostępem do cen),
 * „umowy” = ZIP z umowami sprzedanych sztuk.
 */
export async function POST(req: NextRequest) {
  const db = await createClient();
  const { data: auth } = await db.auth.getClaims();
  if (!auth?.claims?.sub) return new Response("unauthorized", { status: 401 });
  const { data: profile } = await db.from("profiles").select("can_see_prices, active").eq("id", auth.claims.sub).single();
  if (!profile?.active) return new Response("forbidden", { status: 403 });

  const fd = await req.formData();
  const keys = fd.getAll("l").map(String).filter((k) => KEY.test(k)).slice(0, 5000);
  const what = String(fd.get("eksport") ?? "");
  const label = String(fd.get("okres") ?? fd.get("miesiac") ?? "").replace(/[^\d-]/g, "").slice(0, 7) || new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw" }).format(new Date());
  // „…z ostatniego miesiąca”: bez zaznaczania – wszystkie linie z dokumentem z podanego miesiąca.
  const wholeMonth = !keys.length && fd.get("miesiac") ? monthRange(String(fd.get("miesiac"))) : null;
  if (!keys.length && !wholeMonth) return new Response("Zaznacz sprzedaże.", { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });

  try {
    const lines = wholeMonth ? await loadJpkLines(db, { from: wholeMonth.from, to: wholeMonth.to, kind: "all" }) : await loadJpkLinesByKeys(db, keys);
    if (what === "xlsx") {
      if (!profile.can_see_prices) return new Response("Plik JPK zawiera ceny zakupu – brak dostępu do cen.", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      const buf = await jpkWorkbook(lines);
      return new Response(buf, {
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="JPK-${label}.xlsx"`,
          "Cache-Control": "private, no-store",
        },
      });
    }
    const entries = lines.filter((l) => l.contractId).map((l) => ({ contractId: l.contractId!, prefix: l.docNumber ? `${l.kind === "invoice" ? "FV" : "PAR"} ${l.docNumber}` : l.orderLabel }));
    const zip = await contractsZip(db, entries, !!profile.can_see_prices);
    if (!zip) return new Response("Zaznaczone sprzedaże nie mają umów.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    return zipResponse(zip, `umowy-${label}.zip`);
  } catch (e) {
    return new Response(errorMessage(e), { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}
