import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runLiveSync } from "@/lib/sync/live";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Odczyt na żywo z otwartej aplikacji (co ~20 s): ostatnie zamówienia i zmienione stany ze Shopify. */
export async function GET() {
  const { data: auth } = await (await createClient()).auth.getClaims();
  if (!auth?.claims?.sub) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const r = await runLiveSync(createAdminClient());
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
