import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyWebhook } from "@/lib/integrations/shopify";
import { removeShopifyProduct, syncSingleProduct, type Store } from "@/lib/sync/catalog";

export const dynamic = "force-dynamic";

/** Webhooki products/create i products/update z każdego sklepu: /api/shopify/webhook/<kod sklepu>. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ store: string }> }) {
  const { store: code } = await params;
  const raw = await req.text();
  if (!verifyWebhook(raw, req.headers.get("x-shopify-hmac-sha256"), code)) {
    return NextResponse.json({ error: "invalid hmac" }, { status: 401 });
  }
  const db = createAdminClient();
  const { data: store } = await db.from("stores").select("*").eq("code", code).single();
  if (!store) return NextResponse.json({ error: "unknown store" }, { status: 404 });

  const body = JSON.parse(raw) as { admin_graphql_api_id?: string; id?: number };
  const gid = body.admin_graphql_api_id ?? (body.id ? `gid://shopify/Product/${body.id}` : null);
  if (!gid) return NextResponse.json({ ok: true });
  try {
    if (req.headers.get("x-shopify-topic") === "products/delete") await removeShopifyProduct(db, store as Store, gid);
    else await syncSingleProduct(db, store as Store, gid);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.from("sync_log").insert({ job: `shopify-webhook-${code}`, ok: false, message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
