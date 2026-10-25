import "server-only";
import { errorMessage } from "@/lib/errors";
import type { SupabaseClient } from "@supabase/supabase-js";
import { productsUpdatedSince } from "@/lib/integrations/shopify";
import { detachDeletedShopifyProducts, splitSameStoreDuplicates, upsertShopifyProducts, type Store } from "./catalog";
import { syncStock } from "./shopify-stock";
import { syncCollections } from "./collections";
import { catalogIssues, syncIssues } from "@/lib/issues";

/**
 * Automat katalogu (co ~15 min z zadania cyklicznego; na żywo robią to webhooki Shopify):
 * 1. nowe i zmienione produkty ze Shopify (z cenami) → katalog,
 * 2. stany: Shopify → sztuki w Magazynie albo (gdy główny jest magazyn aplikacji) aplikacja → Shopify.
 */

/** seen – produkty z datą zmiany równą `since` (już odczytane; Shopify szuka „od” włącznie), highIds – te przy `high`. */
type ShopState = { since: string; after: string | null; high: string; seen?: string[]; highIds?: string[] };

/**
 * Produkty ze Shopify zmienione od ostatniego razu (po 50 na stronę) – do limitu stron albo czasu;
 * reszta przy następnym odczycie (kursor w sync_state). `pending` = sklepy, w których zostało więcej.
 */
export async function syncShopifyProductsIncremental(db: SupabaseClient, maxPages = 20, deadline = Date.now() + 90_000) {
  const { data: stores } = await db.from("stores").select("*").not("shopify_domain", "is", null);
  const out: Record<string, number> = {};
  const pending: string[] = [];
  for (const store of (stores ?? []) as Store[]) {
    // Sklep-kopia nie ma własnego katalogu (produkty tworzy w nim aplikacja).
    if (store.mirror_of) continue;
    const key = `shopify_products:${store.id}`;
    const { data: st } = await db.from("sync_state").select("value").eq("key", key).maybeSingle();
    const state: ShopState = (st?.value as ShopState) ?? { since: "2000-01-01T00:00:00Z", after: null, high: "2000-01-01T00:00:00Z" };
    let count = 0;
    let more = false;
    for (let page = 0; page < maxPages; page++) {
      if (Date.now() > deadline) { more = true; break; }
      const r = await productsUpdatedSince(store.shopify_domain!, store.code, state.since, state.after);
      // Ostatni produkt z poprzedniego odczytu wraca przy każdym sprawdzeniu (zapytanie „od” jest włącznie) –
      // pomijamy go, jeśli od tamtej pory się nie zmienił (np. „zmieniło się 2 produktów: AirPods 4” za każdym razem).
      const seen = new Set(state.seen ?? []);
      const fresh = r.nodes.filter((p) => !(p.updatedAt === state.since && seen.has(p.id)));
      if (fresh.length) await upsertShopifyProducts(db, store, fresh);
      count += fresh.length;
      for (const p of r.nodes) {
        if (p.updatedAt > state.high) { state.high = p.updatedAt; state.highIds = [p.id]; }
        else if (p.updatedAt === state.high && !(state.highIds ?? []).includes(p.id)) state.highIds = [...(state.highIds ?? []), p.id];
      }
      if (r.pageInfo.hasNextPage) {
        state.after = r.pageInfo.endCursor;
        more = page === maxPages - 1;
      } else {
        if (state.high !== state.since) state.seen = state.highIds ?? [];
        else state.seen = [...new Set([...(state.seen ?? []), ...(state.highIds ?? [])])];
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
  // Błąd jednego etapu nie zatrzymuje pozostałych – trafia do „Błędów automatu” (Ustawienia).
  let catalogError: string | null = null;
  const shopify = await syncShopifyProductsIncremental(db, force ? 200 : 20, Date.now() + (force ? 210_000 : 90_000))
    .catch((e) => { catalogError = errorMessage(e); return {} as Record<string, number>; });
  // Produkty usunięte w Shopify i rozmiary bez śledzenia stanu → „brak w Shopify”; ich sztuki bez historii znikają
  // (z umową / sprzedażą – zostają z oznaczeniem). Duże porcje zatwierdza się przyciskiem w Ustawieniach.
  const deleted = await detachDeletedShopifyProducts(db).catch((e) => `błąd: ${errorMessage(e)}`);
  // Osobne produkty z tym samym SKU w jednym sklepie (np. używane pary) → osobne produkty w aplikacji.
  const split = await splitSameStoreDuplicates(db, force ? 200 : 25).catch((e) => `błąd: ${errorMessage(e)}`);
  const { data: purged, error: purgeErr } = await db.rpc("purge_non_shopify", { p_dry_run: false, p_max: 100 });
  // Jednorazowo: starsze zamówienia z parami „z bazowego modelu” (np. AF1 Rope) – „Dołącz umowę” w zamówieniu i JPK.
  const madeFrom = await (await import("@/lib/sync/shop-orders")).remapMadeFromOrders(db).catch((e) => `błąd: ${errorMessage(e)}`);
  // Sklepy-kopie (np. Owca Store): co 30 minut (mniej zapisów w Shopify kopii) – nowe i zmienione produkty źródła
  // → kopia (do ~2,5 min, reszta przy kolejnym przebiegu), potem usunięcie z kopii produktów bez powiązania z magazynem.
  // Pojedyncze zmiany z webhooków źródła idą od razu, niezależnie od tego rytmu.
  const mirror = await (async () => {
    const m = await import("./mirror");
    if (!(await m.mirrorPairs(db, true)).length) return {};
    const { data: ms } = await db.from("sync_state").select("value").eq("key", "mirror_run").maybeSingle();
    const lastMirror = (ms?.value as { at?: string } | null)?.at;
    if (!force && lastMirror && Date.now() - Date.parse(lastMirror) < 29 * 60_000) return {};
    await db.from("sync_state").upsert({ key: "mirror_run", value: { at: new Date().toISOString() }, updated_at: new Date().toISOString() });
    const r = await m.runMirror(db, { deadline: Math.min(Date.now() + (force ? 90_000 : 150_000), started + 180_000), parallel: 2 });
    // Produkty źródła spoza magazynu (np. Rope) – 1:1 w kopii.
    const extras = await m.runMirrorExtras(db, { deadline: Math.min(Date.now() + 45_000, started + 200_000) }).catch((e) => `błąd: ${errorMessage(e)}`);
    const cleanup = await m.cleanupMirrors(db, { deadline: Math.min(Date.now() + 30_000, started + 230_000) }).catch((e) => `błąd: ${errorMessage(e)}`);
    return { ...r, ...(typeof extras === "string" || Object.keys(extras).length ? { spoza_magazynu: extras } : {}), ...(typeof cleanup === "string" || Object.keys(cleanup).length ? { usuwanie: cleanup } : {}) };
  })().catch((e) => `błąd: ${errorMessage(e)}`);
  const stock: Awaited<ReturnType<typeof syncStock>> | { error: string; master?: undefined; result?: undefined } = await syncStock(db).catch((e) => ({ error: errorMessage(e) }));
  // Kolekcje (kategorie do filtra w Magazynie): z automatu co ~3 godziny, z przycisku – gdy starsze niż 30 min.
  const collections = await syncCollections(db, {
    deadline: Math.min(Date.now() + (force ? 45_000 : 60_000), started + 270_000),
    minAgeMs: force ? 30 * 60_000 : 3 * 3600_000,
  }).catch((e) => `błąd: ${errorMessage(e)}`);
  const result = { shopify, deleted, split, ...(typeof mirror === "string" || Object.keys(mirror).length ? { mirror } : {}), stock, collections, notInShopify: purgeErr ? purgeErr.message : purged, catalogError, ...(madeFrom ? { madeFrom } : {}) };
  await syncIssues(db, "auto-catalog", catalogIssues(result));
  return result;
}
