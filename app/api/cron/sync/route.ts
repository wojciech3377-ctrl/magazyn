import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cronAuthorized, runFastJobs } from "@/lib/sync/jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Co minutę (pg_cron w Supabase, nagłówek Authorization: Bearer CRON_SECRET): zamówienia, stany, przesyłki. */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const r = await runFastJobs(createAdminClient());
  return NextResponse.json(r, { status: r.ok ? 200 : 500 });
}
export const POST = GET;
