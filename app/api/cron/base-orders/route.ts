import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cronAuthorized, runFastJobs, runSlowJobs } from "@/lib/sync/jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Stary adres zadania cyklicznego (zostaje, żeby dotychczasowy pg_cron działał): zamówienia i stany od razu,
 * katalog co 15 min. Nowe ustawienie: supabase/cron.sql – /api/cron/sync co minutę i /api/cron/katalog co 10 min.
 */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = createAdminClient();
  const fast = await runFastJobs(db);
  const slow = await runSlowJobs(db);
  return NextResponse.json({ fast, slow }, { status: fast.ok && slow.ok ? 200 : 500 });
}
export const POST = GET;
