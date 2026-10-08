import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getOrdersConfirmedFrom, type BaseOrder } from "@/lib/integrations/base";
import { isExcluded, loadExclusions, type Exclusions } from "@/lib/services";

const STATE_KEY = "base_orders";

/**
 * Odczyt nowych zamówień z Base i oznaczenie sprzedanych sztuk (najpierw własne, potem komis,
 * od najstarszej). Bezpieczne przy ponownym uruchomieniu: każda linia zamówienia zapisuje się raz.
 */
export async function syncBaseOrders(db: SupabaseClient, maxPages = 10) {
  // Punkt startowy ustawia jednorazowe wgranie stanów z Base (Ustawienia). Wcześniej nic nie liczymy,
  // bo zamówienia zdjęłyby sztuki, których jeszcze nie ma.
  const { data: st } = await db.from("sync_state").select("value").eq("key", STATE_KEY).maybeSingle();
  if (!st) return { orders: 0, lines: 0, from: null, note: "czekam na wgranie stanów z Base" };
  let from = Number((st.value as { from: number }).from);

  const { data: stores } = await db.from("stores").select("id, base_order_source_id");
  const storeBySource = new Map((stores ?? []).filter((s) => s.base_order_source_id).map((s) => [Number(s.base_order_source_id), s.id as string]));

  const exclusions = await loadExclusions(db);
  let orders = 0;
  let lines = 0;
  for (let page = 0; page < maxPages; page++) {
    const batch = await getOrdersConfirmedFrom(from);
    if (!batch.length) break;
    lines += await processOrders(db, batch, storeBySource, exclusions);
    orders += batch.length;

    // Kursor zostaje na ostatniej sekundzie (zamówienia z tej sekundy mogą jeszcze dojść; zapis jest
    // idempotentny). Do przodu o 1 s tylko, gdy cała pełna strona ma tę samą sekundę.
    const maxConfirmed = Math.max(...batch.map((o) => o.date_confirmed ?? from));
    const next = batch.length === 100 && maxConfirmed === from ? from + 1 : maxConfirmed;
    const advanced = next !== from;
    from = next;
    await db.from("sync_state").update({ value: { from }, updated_at: new Date().toISOString() }).eq("key", STATE_KEY);
    if (batch.length < 100 || !advanced) break;
  }
  return { orders, lines, from };
}

async function processOrders(db: SupabaseClient, orders: BaseOrder[], storeBySource: Map<number, string>, exclusions: Exclusions) {
  const baseIds = new Set<number>();
  const shopVariantIds = new Set<string>();
  for (const o of orders) {
    for (const p of o.products ?? []) {
      const id = p.variant_id && p.variant_id !== "0" ? p.variant_id : p.product_id;
      if (!id) continue;
      if (p.storage === "shop") shopVariantIds.add(`gid://shopify/ProductVariant/${id}`);
      else if (/^\d+$/.test(id)) baseIds.add(Number(id));
    }
  }

  const variantByBase = new Map<number, string>();
  const variantByShop = new Map<string, string>();
  if (baseIds.size) {
    const { data, error } = await db.from("variant_store_links").select("variant_id, base_product_id")
      .in("base_product_id", [...baseIds]).in("base_link_source", ["base", "manual"]);
    if (error) throw error;
    for (const r of data!) variantByBase.set(Number(r.base_product_id), r.variant_id as string);
  }
  if (shopVariantIds.size) {
    const { data, error } = await db.from("variant_store_links").select("variant_id, shopify_variant_id")
      .in("shopify_variant_id", [...shopVariantIds]);
    if (error) throw error;
    for (const r of data!) variantByShop.set(r.shopify_variant_id as string, r.variant_id as string);
  }

  let lines = 0;
  for (const o of orders) {
    const storeId = o.order_source === "shop" && o.order_source_id ? storeBySource.get(Number(o.order_source_id)) ?? null : null;
    const ref = o.external_order_id || (o.shop_order_id ? String(o.shop_order_id) : `Base ${o.order_id}`);
    for (const p of o.products ?? []) {
      if (isExcluded(exclusions, [p.sku], p.name)) continue;
      const id = p.variant_id && p.variant_id !== "0" ? p.variant_id : p.product_id;
      const variantId = !id ? null
        : p.storage === "shop" ? variantByShop.get(`gid://shopify/ProductVariant/${id}`) ?? null
        : variantByBase.get(Number(id)) ?? null;
      const { error } = await db.rpc("register_sale", {
        p_store_id: storeId,
        p_base_order_id: o.order_id,
        p_base_order_product_id: p.order_product_id,
        p_variant_id: variantId,
        p_quantity: p.quantity,
        p_order_ref: ref,
        p_product_name: [p.name, p.sku].filter(Boolean).join(" · "),
        p_sold_at: new Date((o.date_confirmed ?? o.date_add ?? Date.now() / 1000) * 1000).toISOString(),
      });
      if (error) throw error;
      lines++;
    }
  }
  return lines;
}
