import { after, NextResponse, type NextRequest } from "next/server";
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
  // Shopify czeka na odpowiedź najwyżej 5 s (inaczej ponawia, a po wielu porażkach wyłącza webhook) –
  // odpowiadamy od razu, pracę robimy po odpowiedzi. Błędy trafiają do dziennika; zadania co minutę i tak nadrabiają.
  after(async () => {
    try {
      if (topic.startsWith("orders/") || topic === "refunds/create") {
        const orderGid = topic === "refunds/create"
          ? (body.order_id ? `gid://shopify/Order/${body.order_id}` : null)
          : body.admin_graphql_api_id ?? (body.id ? `gid://shopify/Order/${body.id}` : null);
        if (orderGid && store.shopify_domain) {
          const order = await getOrder(store.shopify_domain, store.code, orderGid);
          if (order) await saveShopifyOrders(db, store.id, [order]);
        }
      } else if (store.mirror_of && (topic === "inventory_levels/update" || topic.startsWith("products/"))) {
        // Sklep-kopia: produkty i stany prowadzi aplikacja (zmiany ze źródła). Usunięty ręcznie produkt odtworzy automat kopii.
        if (topic === "products/delete") {
          const gid = body.admin_graphql_api_id ?? (body.id ? `gid://shopify/Product/${body.id}` : null);
          if (gid) await removeShopifyProduct(db, store as Store, gid);
        }
      } else if (topic === "inventory_levels/update") {
        if (body.inventory_item_id && body.location_id && typeof body.available === "number") {
          await reconcileShopifyLevel(db, store.id, `gid://shopify/InventoryItem/${body.inventory_item_id}`, `gid://shopify/Location/${body.location_id}`, body.available);
        }
      } else {
        const gid = body.admin_graphql_api_id ?? (body.id ? `gid://shopify/Product/${body.id}` : null);
        if (!gid) return;
        if (topic === "products/delete") await removeShopifyProduct(db, store as Store, gid);
        else {
          await syncSingleProduct(db, store as Store, gid);
          // Kopie tego sklepu (np. Owca Store): ten produkt od razu (przy błędzie zostaje w kolejce automatu).
          const { mirrorPairs, mirrorProduct } = await import("@/lib/sync/mirror");
          const pairs = (await mirrorPairs(db)).filter((p) => p.source.id === store.id);
          if (pairs.length) {
            const { data: link } = await db.from("product_store_links").select("product_id").eq("store_id", store.id).eq("shopify_product_id", gid).maybeSingle();
            for (const pair of link ? pairs : []) {
              await mirrorProduct(db, pair, link!.product_id as string).then(
                () => db.from("mirror_queue").delete().eq("store_id", pair.mirror.id).eq("product_id", link!.product_id),
                () => null);
            }
          }
        }
        // Usunięty produkt / rozmiar → z magazynu od razu (tylko sztuki bez historii).
        await db.rpc("purge_non_shopify", { p_dry_run: false, p_max: 100 });
      }
    } catch (e) {
      await db.from("sync_log").insert({ job: `shopify-webhook-${code}`, ok: false, message: `${topic}: ${errorMessage(e)}` });
    }
  });
  return NextResponse.json({ ok: true });
}
