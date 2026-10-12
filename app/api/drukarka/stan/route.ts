import { createAdminClient } from "@/lib/supabase/admin";
import { printerFromRequest } from "@/lib/fiscal/jobs";

export const dynamic = "force-dynamic";

/** Stan programu i drukarki (co minutę): wersja programu, model, połączenie, ostatni błąd – widać w Ustawieniach. */
export async function POST(req: Request) {
  const db = createAdminClient();
  const printer = await printerFromRequest(db, req);
  if (!printer) return Response.json({ error: "Zły klucz drukarki." }, { status: 401 });
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // pusty stan też jest sygnałem życia
  }
  const status = Object.fromEntries(Object.entries(body).slice(0, 20).map(([k, v]) => [k.slice(0, 40), typeof v === "string" ? v.slice(0, 300) : v]));
  await db.from("fiscal_printers").update({ last_seen_at: new Date().toISOString(), last_status: status }).eq("id", printer.id);
  return Response.json({ ok: true, name: printer.name });
}
