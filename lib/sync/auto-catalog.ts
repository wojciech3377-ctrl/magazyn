import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getInventoryStockPage, listNewestProductIds } from "@/lib/integrations/base";
import { productsUpdatedSince } from "@/lib/integrations/shopify";
import { upsertShopifyProducts, type Store } from "./catalog";
import { upsertBaseProducts } from "./base-catalog";

/**
 * Automat katalogu (co ~15 min z zadania cyklicznego):
 * 1. nowe i zmienione produkty ze Shopify (z cenami) → katalog,
 * 2. nowe produkty z Base → base_products + powiązania rozmiarów,
 * 3. stany z Base → brakujące sztuki „bez umowy” w Magazynie (gdy w Base jest więcej niż w aplikacji).
 */

type ShopState = { since: string; after: string | null; high: string };

export async function syncShopifyProductsIncremental(db: SupabaseClient, maxPages = 6) {
  const { data: stores } = await db.from("stores").select("*").not("shopify_domain", "is", null);
  const out: Record<string, number> = {};
  for (const store of (stores ?? []) as Store[]) {
    const key = `shopify_products:${store.id}`;
    const { data: st } = await db.from("sync_state").select("value").eq("key", key).maybeSingle();
    const state: ShopState = (st?.value as ShopState) ?? { since: "2000-01-01T00:00:00Z", after: null, high: "2000-01-01T00:00:00Z" };
    let count = 0;
    for (let page = 0; page < maxPages; page++) {
      const r = await productsUpdatedSince(store.shopify_domain!, store.code, state.since, state.after);
      if (r.nodes.length) await upsertShopifyProducts(db, store, r.nodes);
      count += r.nodes.length;
      for (const p of r.nodes) if (p.updatedAt > state.high) state.high = p.updatedAt;
      if (r.pageInfo.hasNextPage) {
        state.after = r.pageInfo.endCursor;
      } else {
        state.since = state.high;
        state.after = null;
        break;
      }
    }
    await db.from("sync_state").upsert({ key, value: state, updated_at: new Date().toISOString() });
    out[store.name] = count;
  }
  return out;
}

/** Nowe produkty w Base (najnowsze ID, których nie ma w base_products) i powiązanie ich rozmiarów. */
export async function syncNewBaseProducts(db: SupabaseClient) {
  const { data: stores } = await db.from("stores").select("id, base_inventory_id").not("base_inventory_id", "is", null);
  const inventories = [...new Set((stores ?? []).map((s) => Number(s.base_inventory_id)))];
  let added = 0;
  for (const inv of inventories) {
    const ids = await listNewestProductIds(inv);
    if (!ids.length) continue;
    const known = new Set<number>();
    for (let i = 0; i < ids.length; i += 300) {
      const { data } = await db.from("base_products").select("id").eq("inventory_id", inv).in("id", ids.slice(i, i + 300));
      for (const r of data ?? []) known.add(Number(r.id));
    }
    const fresh = ids.filter((id) => !known.has(id)).slice(0, 200);
    for (let i = 0; i < fresh.length; i += 100) await upsertBaseProducts(db, inv, fresh.slice(i, i + 100));
    added += fresh.length;
  }
  if (added) {
    for (const s of stores ?? []) {
      const { error } = await db.rpc("apply_base_links", { p_store_id: s.id });
      if (error) throw error;
    }
  }
  return { added };
}

/** Stany z Base → brakujące sztuki w Magazynie. */
export async function reconcileStock(db: SupabaseClient) {
  const { data: stores } = await db.from("stores").select("id, base_inventory_id").not("base_inventory_id", "is", null);
  const { data: locations } = await db.from("locations").select("id, store_id, base_warehouse_id").eq("active", true).not("base_warehouse_id", "is", null);
  const locByWarehouse = new Map<string, { id: string; store_id: string }[]>();
  for (const l of locations ?? []) locByWarehouse.set(l.base_warehouse_id as string, [...(locByWarehouse.get(l.base_warehouse_id as string) ?? []), l as { id: string; store_id: string }]);

  // Rozmiary ze zmianami stanu w Base, których aplikacja jeszcze nie wysłała (błąd Base) – pomijamy, żeby nie dublować sztuk.
  const skip = new Set<string>();
  const [{ data: pos }, { data: dels }] = await Promise.all([
    db.from("pos_orders").select("base_pending").eq("base_sync_status", "error"),
    db.from("deliveries").select("id").eq("base_sync_status", "error"),
  ]);
  for (const p of pos ?? []) for (const c of (p.base_pending ?? []) as { variantId?: string }[]) if (c.variantId) skip.add(c.variantId);
  if (dels?.length) {
    const { data: du } = await db.from("units").select("variant_id").in("delivery_id", dels.map((d) => d.id));
    for (const u of du ?? []) skip.add(u.variant_id as string);
  }

  let rowsTotal = 0;
  const results: unknown[] = [];
  for (const store of stores ?? []) {
    const inv = Number(store.base_inventory_id);
    const { data: links } = await db.from("variant_store_links").select("variant_id, base_product_id")
      .eq("store_id", store.id).not("base_product_id", "is", null).in("base_link_source", ["base", "manual"]);
    const variantOf = new Map((links ?? []).map((l) => [Number(l.base_product_id), l.variant_id as string]));
    if (!variantOf.size) continue;
    const rows: { variant_id: string; location_id: string; qty: number }[] = [];
    for (let page = 1; page < 60; page++) {
      const products = await getInventoryStockPage(inv, page);
      const entries = Object.entries(products);
      for (const [pid, e] of entries) {
        const add = (baseId: number, stock: Record<string, number> | undefined) => {
          const variantId = variantOf.get(baseId);
          if (!variantId || skip.has(variantId) || !stock) return;
          for (const [wh, qty] of Object.entries(stock)) {
            if (!(Number(qty) > 0)) continue;
            const locs = locByWarehouse.get(wh);
            if (!locs?.length) continue;
            const loc = locs.find((l) => l.store_id === store.id) ?? locs[0];
            rows.push({ variant_id: variantId, location_id: loc.id, qty: Math.floor(Number(qty)) });
          }
        };
        const variants = e.variants && !Array.isArray(e.variants) ? e.variants : {};
        if (Object.keys(variants).length) for (const [vid, st] of Object.entries(variants)) add(Number(vid), st);
        else add(Number(pid), e.stock);
      }
      if (entries.length < 1000) break;
    }
    rowsTotal += rows.length;
    const { data, error } = await db.rpc("reconcile_base_stock", { p_rows: rows, p_limit: 300 });
    if (error) throw error;
    results.push(data);
  }
  return { checked: rowsTotal, results };
}

/** Cały automat z blokadą częstotliwości (co 15 minut). */
export async function runAutoCatalog(db: SupabaseClient, force = false) {
  const { data: st } = await db.from("sync_state").select("value").eq("key", "auto_catalog").maybeSingle();
  const last = (st?.value as { at?: string } | null)?.at;
  if (!force && last && Date.now() - Date.parse(last) < 14 * 60_000) return null;
  await db.from("sync_state").upsert({ key: "auto_catalog", value: { at: new Date().toISOString() }, updated_at: new Date().toISOString() });
  const shopify = await syncShopifyProductsIncremental(db);
  const base = await syncNewBaseProducts(db);
  const stock = await reconcileStock(db);
  return { shopify, base, stock };
}
