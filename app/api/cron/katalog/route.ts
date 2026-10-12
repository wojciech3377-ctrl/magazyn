import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cronAuthorized, runSlowJobs } from "@/lib/sync/jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Co 10 minut: katalog produktów ze Shopify i pełne porównanie stanów (ciężkie – osobno od zamówień). */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const r = await runSlowJobs(createAdminClient());
  return NextResponse.json(r, { status: r.ok ? 200 : 500 });
}
export const POST = GET;
