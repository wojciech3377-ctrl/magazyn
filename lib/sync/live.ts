import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recentOrders } from "@/lib/integrations/shopify";
import { saveShopifyOrders } from "@/lib/sync/shop-orders";
import { reconcileRecentFromShopify } from "@/lib/sync/shopify-stock";
import { errorMessage } from "@/lib/errors";

/**
 * Odczyt „na żywo” (gdy ktoś ma otwartą aplikację – co ~60 s, i z zadania cyklicznego co minutę):
 * ostatnie 5 zmienionych zamówień z każdego sklepu i stany zmienione w Shopify od ostatniego sprawdzenia.
 * Blokada: najwyżej raz na `minGapMs` dla wszystkich użytkowników razem.
 */
export async function runLiveSync(db: SupabaseClient, minGapMs = 45_000) {
  const now = Date.now();
  const { data: st } = await db.from("sync_state").select("value").eq("key", "live_sync").maybeSingle();
  const last = (st?.value as { at?: string } | null)?.at;
  if (last && now - Date.parse(last) < minGapMs) return { skipped: true as const, at: last };
  await db.from("sync_state").upsert({ key: "live_sync", value: { at: new Date(now).toISOString() }, updated_at: new Date().toISOString() });

  const { data: stores } = await db.from("stores").select("id, code, name, shopify_domain").not("shopify_domain", "is", null);
  let newOrders = 0;
  const errors: string[] = [];
  for (const s of stores ?? []) {
    try {
      const orders = await recentOrders(s.shopify_domain as string, s.code as string, 5);
      if (!orders.length) continue;
      // Tylko nowe albo zmienione od zapisu (porównanie daty zmiany) – reszta bez zapisu.
      const { data: known } = await db.from("orders").select("shopify_order_id, shop_updated_at").eq("store_id", s.id).in("shopify_order_id", orders.map((o) => o.id));
      const seen = new Map((known ?? []).map((k) => [k.shopify_order_id as string, (k.shop_updated_at as string | null) ?? ""]));
      const fresh = orders.filter((o) => !seen.has(o.id) || (o.updatedAt && Date.parse(o.updatedAt) > Date.parse(seen.get(o.id) || "1970-01-01")));
      if (fresh.length) {
        await saveShopifyOrders(db, s.id as string, fresh);
        newOrders += fresh.length;
      }
    } catch (e) {
      errors.push(`${s.name}: ${errorMessage(e)}`);
    }
  }
  if (newOrders) await db.rpc("settle_order_units").then(() => null, () => null);
  let stock: unknown = null;
  try {
    stock = await reconcileRecentFromShopify(db);
  } catch (e) {
    errors.push(`stany: ${errorMessage(e)}`);
  }
  if (errors.length) await db.from("sync_log").insert({ job: "live", ok: false, message: errors.join("; ") });
  return { skipped: false as const, at: new Date(now).toISOString(), orders: newOrders, stock, errors };
}
