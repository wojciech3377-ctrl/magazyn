import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cronAuthorized } from "@/lib/sync/jobs";
import { createDbBackup, pruneBackups } from "@/lib/backup";
import { errorMessage } from "@/lib/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Raz dziennie (pg_cron w Supabase – SQL 73): kopia danych aplikacji do „backups”, starsze niż 30 dni usuwane. */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = createAdminClient();
  try {
    const r = await createDbBackup(db);
    const pruned = await pruneBackups(db).catch(() => 0);
    await db.from("sync_log").insert({ job: "backup", ok: true, message: JSON.stringify({ path: r.path, size: r.size, seconds: r.seconds, pruned, skipped: r.skipped }) });
    return NextResponse.json({ ok: true, path: r.path, size: r.size, pruned });
  } catch (e) {
    await db.from("sync_log").insert({ job: "backup", ok: false, message: errorMessage(e) });
    return NextResponse.json({ ok: false, error: errorMessage(e) }, { status: 500 });
  }
}
export const POST = GET;
