import { createAdminClient } from "@/lib/supabase/admin";
import { printerFromRequest } from "@/lib/fiscal/jobs";
import { printoutNumber } from "@/lib/fiscal/printout";

export const dynamic = "force-dynamic";

/** Wynik wydruku: {"ok": true, "number": "000123"} albo {"ok": false, "error": "brak papieru"}. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = createAdminClient();
  const printer = await printerFromRequest(db, req);
  if (!printer) return Response.json({ error: "Zły klucz drukarki." }, { status: 401 });
  if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: "Złe zadanie." }, { status: 400 });
  let body: { ok?: boolean; number?: string; error?: string; daily?: string; printout?: boolean; text?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Zła treść." }, { status: 400 });
  }
  const ok = body.ok === true;
  // Numer jak na wydruku z drukarki: 9 cyfr z zerami z przodu (np. 1441 → 000001441).
  const raw = String(body.number ?? "").trim().slice(0, 60);
  // Numer z treści paragonu („nr dok.000001453”) ma pierwszeństwo – działa też ze starszym programem na komputerze.
  const number = printoutNumber(body.text) ?? (/^\d{1,8}$/.test(raw) ? raw.padStart(9, "0") : raw);
  if (ok && !number) return Response.json({ error: "Brak numeru paragonu." }, { status: 400 });
  const { data, error } = await db.rpc("finish_receipt_job", { p_printer: printer.id, p_id: id, p_ok: ok, p_number: number || null, p_error: ok ? null : String(body.error ?? "błąd drukarki") });
  if (error) return Response.json({ error: error.message }, { status: 409 });
  // Program 0.3+: numer w dobie i treść paragonu z kopii elektronicznej (do sprawdzenia numeru wydruku). Bez migracji 0047 – pomijane.
  if (ok && (body.daily || body.text)) {
    const extra = { daily_no: String(body.daily ?? "").slice(0, 20) || null, printout_text: String(body.text ?? "").slice(0, 8000) || null };
    await db.from("receipt_jobs").update(extra).eq("id", id).then(() => null, () => null);
    await db.from("receipts").update({ daily_no: extra.daily_no }).eq("job_id", id).then(() => null, () => null);
  }
  return Response.json({ status: data });
}
