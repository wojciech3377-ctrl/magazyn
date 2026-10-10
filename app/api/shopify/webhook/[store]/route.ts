import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getOrder, verifyWebhook } from "@/lib/integrations/shopify";
import { removeShopifyProduct, syncSingleProduct, type Store } from "@/lib/sync/catalog";
import { saveShopifyOrders } from "@/lib/sync/shop-orders";
import { reconcileShopifyLevel } from "@/lib/sync/shopify-stock";
import { errorMessage } from "@/lib/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Webhooki Shopify z każdego sklepu: /api/shopify/webhook/<kod sklepu>.
 * Produkty (nowe / zmiany / usunięcie), zamówienia (nowe, zmiany, anulowanie, zwroty) i stany magazynowe.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ store: string }> }) {
  const { store: code } = await params;
  const raw = await req.text();
  if (!verifyWebhook(raw, req.headers.get("x-shopify-hmac-sha256"), code)) {
    return NextResponse.json({ error: "invalid hmac" }, { status: 401 });
  }
  const db = createAdminClient();
  const { data: store } = await db.from("stores").select("*").eq("code", code).single();
  if (!store) return NextResponse.json({ error: "unknown store" }, { status: 404 });

  const topic = req.headers.get("x-shopify-topic") ?? "";
  const body = JSON.parse(raw) as {
    admin_graphql_api_id?: string; id?: number; order_id?: number;
    inventory_item_id?: number; location_id?: number; available?: number | null;
  };
  try {
    if (topic.startsWith("orders/") || topic === "refunds/create") {
      const orderGid = topic === "refunds/create"
        ? (body.order_id ? `gid://shopify/Order/${body.order_id}` : null)
        : body.admin_graphql_api_id ?? (body.id ? `gid://shopify/Order/${body.id}` : null);
      if (orderGid && store.shopify_domain) {
        const order = await getOrder(store.shopify_domain, store.code, orderGid);
        if (order) await saveShopifyOrders(db, store.id, [order]);
      }
    } else if (topic === "inventory_levels/update") {
      if (body.inventory_item_id && body.location_id && typeof body.available === "number") {
        await reconcileShopifyLevel(db, store.id, `gid://shopify/InventoryItem/${body.inventory_item_id}`, `gid://shopify/Location/${body.location_id}`, body.available);
      }
    } else {
      const gid = body.admin_graphql_api_id ?? (body.id ? `gid://shopify/Product/${body.id}` : null);
      if (!gid) return NextResponse.json({ ok: true });
      if (topic === "products/delete") await removeShopifyProduct(db, store as Store, gid);
      else await syncSingleProduct(db, store as Store, gid);
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = errorMessage(e);
    await db.from("sync_log").insert({ job: `shopify-webhook-${code}`, ok: false, message: `${topic}: ${message}` });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
