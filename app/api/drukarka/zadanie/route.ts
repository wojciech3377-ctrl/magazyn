import { createAdminClient } from "@/lib/supabase/admin";
import { printerFromRequest } from "@/lib/fiscal/jobs";

export const dynamic = "force-dynamic";

/**
 * Program drukarki (Windows) pyta co kilka sekund: GET /api/drukarka/zadanie z nagłówkiem Authorization: Bearer <klucz>.
 * 204 = nic do wydruku; 200 = paragon do wydruku (od teraz „drukuje się” – tylko ta drukarka go dostaje).
 */
export async function GET(req: Request) {
  const db = createAdminClient();
  const printer = await printerFromRequest(db, req);
  if (!printer) return Response.json({ error: "Zły klucz drukarki albo drukarka wyłączona w Ustawieniach." }, { status: 401 });
  const { data, error } = await db.rpc("claim_receipt_job", { p_printer: printer.id });
  if (error) return Response.json({ error: error.message }, { status: 500 });
  const job = ((data ?? []) as { id: string; number: number; source: string; lines: unknown; total: number; payment: string; created_at: string }[])[0];
  if (!job) return new Response(null, { status: 204 });
  return Response.json({ id: job.id, number: job.number, source: job.source, lines: job.lines, total: Number(job.total), payment: job.payment, created_at: job.created_at });
}
