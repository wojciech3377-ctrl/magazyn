import "server-only";
import { errorMessage } from "@/lib/errors";
import type { SupabaseClient } from "@supabase/supabase-js";
import { productsUpdatedSince } from "@/lib/integrations/shopify";
import { detachDeletedShopifyProducts, splitSameStoreDuplicates, upsertShopifyProducts, type Store } from "./catalog";
import { syncStock } from "./shopify-stock";
import { syncCollections } from "./collections";

/**
 * Automat katalogu (co ~15 min z zadania cyklicznego; na żywo robią to webhooki Shopify):
 * 1. nowe i zmienione produkty ze Shopify (z cenami) → katalog,
 * 2. stany: Shopify → sztuki w Magazynie albo (gdy główny jest magazyn aplikacji) aplikacja → Shopify.
 */

type ShopState = { since: string; after: string | null; high: string };

/**
 * Produkty ze Shopify zmienione od ostatniego razu (po 50 na stronę) – do limitu stron albo czasu;
 * reszta przy następnym odczycie (kursor w sync_state). `pending` = sklepy, w których zostało więcej.
 */
export async function syncShopifyProductsIncremental(db: SupabaseClient, maxPages = 20, deadline = Date.now() + 90_000) {
  const { data: stores } = await db.from("stores").select("*").not("shopify_domain", "is", null);
  const out: Record<string, number> = {};
  const pending: string[] = [];
  for (const store of (stores ?? []) as Store[]) {
    const key = `shopify_products:${store.id}`;
    const { data: st } = await db.from("sync_state").select("value").eq("key", key).maybeSingle();
    const state: ShopState = (st?.value as ShopState) ?? { since: "2000-01-01T00:00:00Z", after: null, high: "2000-01-01T00:00:00Z" };
    let count = 0;
    let more = false;
    for (let page = 0; page < maxPages; page++) {
      if (Date.now() > deadline) { more = true; break; }
      const r = await productsUpdatedSince(store.shopify_domain!, store.code, state.since, state.after);
      if (r.nodes.length) await upsertShopifyProducts(db, store, r.nodes);
      count += r.nodes.length;
      for (const p of r.nodes) if (p.updatedAt > state.high) state.high = p.updatedAt;
      if (r.pageInfo.hasNextPage) {
        state.after = r.pageInfo.endCursor;
        more = page === maxPages - 1;
      } else {
        state.since = state.high;
        state.after = null;
        break;
      }
    }
    await db.from("sync_state").upsert({ key, value: state, updated_at: new Date().toISOString() });
    out[store.name] = count;
    if (more) pending.push(store.name);
  }
  return Object.assign(out, pending.length ? { __pending: pending.length } : {}) as Record<string, number>;
}

/** Cały automat z blokadą częstotliwości (co 15 minut). */
export async function runAutoCatalog(db: SupabaseClient, force = false) {
  const { data: st } = await db.from("sync_state").select("value").eq("key", "auto_catalog").maybeSingle();
  const last = (st?.value as { at?: string } | null)?.at;
  if (!force && last && Date.now() - Date.parse(last) < 14 * 60_000) return null;
  const started = Date.now();
  await db.from("sync_state").upsert({ key: "auto_catalog", value: { at: new Date().toISOString() }, updated_at: new Date().toISOString() });
  // Ręcznie (przycisk) – cały katalog do ~4 min; z automatu – do 1,5 min, reszta przy kolejnym odczycie.
  const shopify = await syncShopifyProductsIncremental(db, force ? 200 : 20, Date.now() + (force ? 210_000 : 90_000));
  // Produkty usunięte w Shopify i rozmiary bez śledzenia stanu → „brak w Shopify”; ich sztuki bez historii znikają
  // (z umową / sprzedażą – zostają z oznaczeniem). Duże porcje zatwierdza się przyciskiem w Ustawieniach.
  const deleted = await detachDeletedShopifyProducts(db).catch((e) => `błąd: ${errorMessage(e)}`);
  // Osobne produkty z tym samym SKU w jednym sklepie (np. używane pary) → osobne produkty w aplikacji.
  const split = await splitSameStoreDuplicates(db, force ? 200 : 25).catch((e) => `błąd: ${errorMessage(e)}`);
  const { data: purged, error: purgeErr } = await db.rpc("purge_non_shopify", { p_dry_run: false, p_max: 100 });
  const stock = await syncStock(db);
  // Kolekcje (kategorie do filtra w Magazynie): z automatu co ~3 godziny, z przycisku – gdy starsze niż 30 min.
  const collections = await syncCollections(db, {
    deadline: Math.min(Date.now() + (force ? 45_000 : 60_000), started + 270_000),
    minAgeMs: force ? 30 * 60_000 : 3 * 3600_000,
  }).catch((e) => `błąd: ${errorMessage(e)}`);
  return { shopify, deleted, split, stock, collections, notInShopify: purgeErr ? purgeErr.message : purged };
}
