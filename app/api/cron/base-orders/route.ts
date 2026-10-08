import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncBaseOrders } from "@/lib/sync/orders";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Wywoływane co kilka minut (pg_cron w Supabase lub Vercel Cron) z nagłówkiem Authorization: Bearer CRON_SECRET. */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const db = createAdminClient();
  try {
    const result = await syncBaseOrders(db);
    await db.from("sync_log").insert({ job: "base-orders", ok: true, message: JSON.stringify(result) });
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.from("sync_log").insert({ job: "base-orders", ok: false, message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const POST = GET;
