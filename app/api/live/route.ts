import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runLiveSync } from "@/lib/sync/live";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Odczyt na żywo z otwartej aplikacji (co ~20 s): ostatnie zamówienia i zmienione stany ze Shopify. */
export async function GET() {
  const db = await createClient();
  const { data: auth } = await db.auth.getClaims();
  if (!auth?.claims?.sub) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Tylko aktywny pracownik (komisant nie uruchamia odczytu ze Shopify); najwyżej co kilka sekund na osobę.
  const { data: profile } = await db.from("profiles").select("active").eq("id", auth.claims.sub).maybeSingle();
  if (!profile?.active) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { rateLimit } = await import("@/lib/security");
  if (!(await rateLimit(`live:${auth.claims.sub}`, 30, 60))) return NextResponse.json({ error: "too many requests" }, { status: 429 });
  try {
    const r = await runLiveSync(createAdminClient());
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
