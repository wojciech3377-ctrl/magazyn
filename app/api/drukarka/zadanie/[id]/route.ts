import { createAdminClient } from "@/lib/supabase/admin";
import { printerFromRequest } from "@/lib/fiscal/jobs";

export const dynamic = "force-dynamic";

/** Wynik wydruku: {"ok": true, "number": "000123"} albo {"ok": false, "error": "brak papieru"}. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = createAdminClient();
  const printer = await printerFromRequest(db, req);
  if (!printer) return Response.json({ error: "Zły klucz drukarki." }, { status: 401 });
  if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: "Złe zadanie." }, { status: 400 });
  let body: { ok?: boolean; number?: string; error?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Zła treść." }, { status: 400 });
  }
  const ok = body.ok === true;
  const number = String(body.number ?? "").trim();
  if (ok && !number) return Response.json({ error: "Brak numeru paragonu." }, { status: 400 });
  const { data, error } = await db.rpc("finish_receipt_job", { p_printer: printer.id, p_id: id, p_ok: ok, p_number: number || null, p_error: ok ? null : String(body.error ?? "błąd drukarki") });
  if (error) return Response.json({ error: error.message }, { status: 409 });
  return Response.json({ status: data });
}
