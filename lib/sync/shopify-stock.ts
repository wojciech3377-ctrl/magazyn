import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { shopifyGraphql } from "@/lib/integrations/shopify";

/**
 * Stany magazynowe między aplikacją a Shopify. Główne źródło wybiera się w Ustawieniach:
 *  - "shopify": stan w Shopify → brakujące sztuki w Magazynie (jak wcześniej z Base),
 *  - "app": liczba sztuk na stanie w aplikacji → „dostępne” w Shopify (aplikacja rozdziela stan na sklepy).
 * Lokalizacja aplikacji wskazuje lokalizację Shopify (locations.shopify_location_id).
 */

export type StockMaster = "shopify" | "app";

export async function getStockMaster(db: SupabaseClient): Promise<StockMaster> {
  const { data } = await db.from("app_settings").select("value").eq("key", "stock").maybeSingle();
  return (data?.value as { master?: string } | null)?.master === "app" ? "app" : "shopify";
}

export type ShopifyLocation = { id: string; name: string; isActive: boolean };

export async function shopifyLocations(domain: string, storeCode: string) {
  const data = await shopifyGraphql<{ locations: { nodes: ShopifyLocation[] } }>(domain, storeCode, `query { locations(first: 50) { nodes { id name isActive } } }`);
  return data.locations.nodes;
}

/** Stan „dostępne” każdej pozycji magazynowej w lokalizacji Shopify: inventoryItemId → ilość. */
export async function readLevels(domain: string, storeCode: string, locationId: string, maxPages = 40) {
  const out = new Map<string, number>();
  let after: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const data: { location: { inventoryLevels: { nodes: { item: { id: string } | null; quantities: { name: string; quantity: number }[] }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } | null } =
      await shopifyGraphql(domain, storeCode,
        `query Levels($id: ID!, $after: String) { location(id: $id) { inventoryLevels(first: 250, after: $after) { nodes { item { id } quantities(names: ["available"]) { name quantity } } pageInfo { hasNextPage endCursor } } } }`,
        { id: locationId, after });
    const levels = data.location?.inventoryLevels;
    if (!levels) break;
    for (const n of levels.nodes) if (n.item) out.set(n.item.id, n.quantities.find((q) => q.name === "available")?.quantity ?? 0);
    if (!levels.pageInfo.hasNextPage) break;
    after = levels.pageInfo.endCursor;
  }
  return out;
}

type Store = { id: string; code: string; name: string; shopify_domain: string };
type Loc = { id: string; store_id: string; shopify_location_id: string | null; active: boolean };
type Link = { variant_id: string; shopify_inventory_item_id: string };

async function storesAndLocations(db: SupabaseClient) {
  const [{ data: stores }, { data: locs }] = await Promise.all([
    db.from("stores").select("id, code, name, shopify_domain").not("shopify_domain", "is", null),
    db.from("locations").select("id, store_id, shopify_location_id, active").order("created_at"),
  ]);
  return { stores: (stores ?? []) as Store[], locs: (locs ?? []) as Loc[] };
}

/** Sklep z jedną aktywną lokalizacją Shopify i jedną lokalizacją w aplikacji – łączy je sam. */
export async function autoMapLocations(db: SupabaseClient) {
  const { stores, locs } = await storesAndLocations(db);
  const mapped: string[] = [];
  for (const s of stores) {
    const mine = locs.filter((l) => l.store_id === s.id && l.active);
    if (mine.length !== 1 || mine[0].shopify_location_id) continue;
    const shop = (await shopifyLocations(s.shopify_domain, s.code)).filter((l) => l.isActive);
    if (shop.length !== 1) continue;
    await db.from("locations").update({ shopify_location_id: shop[0].id }).eq("id", mine[0].id);
    mapped.push(`${s.name}: ${shop[0].name}`);
  }
  return mapped;
}

async function trackedLinks(db: SupabaseClient, storeId: string) {
  const out: Link[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("variant_store_links").select("variant_id, shopify_inventory_item_id")
      .eq("store_id", storeId).eq("inventory_tracked", true).not("shopify_inventory_item_id", "is", null).range(from, from + 999);
    if (error) throw error;
    out.push(...((data ?? []) as Link[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

/** Lokalizacje aplikacji sklepu pogrupowane po lokalizacji Shopify (pierwsza – tam trafiają nowe sztuki). */
function groupByShopLocation(mapped: Loc[]) {
  const groups = new Map<string, Loc[]>();
  for (const l of mapped) groups.set(l.shopify_location_id!, [...(groups.get(l.shopify_location_id!) ?? []), l]);
  return groups;
}

/**
 * Shopify jest główny: stan „dostępne” → brakujące sztuki w aplikacji (mniej w Shopify – nic nie usuwa).
 * Nadwyżka musi się utrzymać do kolejnego odczytu (poza zupełnie nowymi produktami) – patrz reconcile_stock.
 */
export async function reconcileFromShopify(db: SupabaseClient) {
  const { stores, locs } = await storesAndLocations(db);
  const results: Record<string, unknown> = {};
  for (const s of stores) {
    const mapped = locs.filter((l) => l.store_id === s.id && l.active && l.shopify_location_id);
    if (!mapped.length) { results[s.name] = "brak lokalizacji Shopify przy lokalizacjach aplikacji"; continue; }
    const links = await trackedLinks(db, s.id);
    const variantOf = new Map(links.map((l) => [l.shopify_inventory_item_id, l.variant_id]));
    // Ten sam rozmiar w dwóch produktach Shopify (duplikat) – liczymy większy stan, nie sumę.
    const best = new Map<string, { variant_id: string; location_id: string; qty: number; count_locations: string[] }>();
    for (const [shopLoc, group] of groupByShopLocation(mapped)) {
      const levels = await readLevels(s.shopify_domain, s.code, shopLoc);
      for (const [item, qty] of levels) {
        const variantId = variantOf.get(item);
        if (!variantId || qty <= 0) continue;
        const key = `${variantId}|${shopLoc}`;
        if ((best.get(key)?.qty ?? 0) < qty) best.set(key, { variant_id: variantId, location_id: group[0].id, qty, count_locations: group.map((g) => g.id) });
      }
    }
    const { data, error } = await db.rpc("reconcile_stock", {
      p_rows: [...best.values()], p_limit: 300, p_source: `Shopify ${s.name}`, p_scope: mapped.map((l) => l.id), p_confirm_minutes: 10,
    });
    if (error) throw error;
    results[s.name] = data;
  }
  return results;
}

/**
 * Zmiana stanu z webhooka inventory_levels/update (tylko gdy Shopify jest główny). Zupełnie nowy produkt dostaje
 * sztuki od razu; przy pozostałych nadwyżka czeka na potwierdzenie przy odczycie co 15 min.
 */
export async function reconcileShopifyLevel(db: SupabaseClient, storeId: string, inventoryItemId: string, locationId: string, available: number) {
  if ((await getStockMaster(db)) !== "shopify" || available <= 0) return null;
  const [{ data: links }, { data: group }] = await Promise.all([
    db.from("variant_store_links").select("variant_id").eq("store_id", storeId).eq("shopify_inventory_item_id", inventoryItemId).eq("inventory_tracked", true).limit(1),
    db.from("locations").select("id").eq("store_id", storeId).eq("active", true).eq("shopify_location_id", locationId).order("created_at"),
  ]);
  const link = links?.[0];
  if (!link || !group?.length) return null;
  const { data: store } = await db.from("stores").select("name").eq("id", storeId).maybeSingle();
  const { data, error } = await db.rpc("reconcile_stock", {
    p_rows: [{ variant_id: link.variant_id, location_id: group[0].id, qty: available, count_locations: group.map((g) => g.id) }],
    p_limit: 50, p_source: `Shopify ${store?.name ?? ""}`.trim(), p_scope: null, p_confirm_minutes: 10,
  });
  if (error) throw error;
  return data;
}

type Change = { inventoryItemId: string; locationId: string; quantity: number; changeFromQuantity: number };

/** Różnice, gdyby aplikacja była główna: ile pozycji w Shopify trzeba zmienić (bez zapisu). */
export async function planPushToShopify(db: SupabaseClient) {
  const { stores, locs } = await storesAndLocations(db);
  const plan: { store: Store; changes: Change[]; note?: string }[] = [];
  for (const s of stores) {
    const mapped = locs.filter((l) => l.store_id === s.id && l.active && l.shopify_location_id);
    if (!mapped.length) { plan.push({ store: s, changes: [], note: "brak lokalizacji Shopify przy lokalizacjach aplikacji" }); continue; }
    const links = await trackedLinks(db, s.id);
    const { data: counts, error } = await db.rpc("stock_counts", { p_location_ids: mapped.map((l) => l.id) });
    if (error) throw error;
    const shopLocOf = new Map(mapped.map((l) => [l.id, l.shopify_location_id!]));
    const want = new Map<string, number>(); // `${variant}|${shopLoc}` → sztuk
    for (const c of (counts ?? []) as { variant_id: string; location_id: string; qty: number }[]) {
      const key = `${c.variant_id}|${shopLocOf.get(c.location_id)}`;
      want.set(key, (want.get(key) ?? 0) + c.qty);
    }
    // Rozmiary z zamówieniem w ostatnich 30 min: nie podnosimy stanu (zamówienie mogło jeszcze nie zdjąć sztuki w aplikacji).
    const { data: recent } = await db.from("orders").select("line_items").eq("store_id", s.id).gte("ordered_at", new Date(Date.now() - 30 * 60_000).toISOString());
    const recentShopVariants = new Set(((recent ?? []) as { line_items: { shopify_variant_id: string | null }[] }[]).flatMap((o) => o.line_items.map((l) => l.shopify_variant_id)).filter(Boolean));
    const { data: recentLinks } = recentShopVariants.size
      ? await db.from("variant_store_links").select("variant_id").eq("store_id", s.id).in("shopify_variant_id", [...recentShopVariants] as string[])
      : { data: [] };
    const hold = new Set((recentLinks ?? []).map((l) => l.variant_id as string));
    const changes: Change[] = [];
    for (const shopLoc of new Set(mapped.map((l) => l.shopify_location_id!))) {
      const levels = await readLevels(s.shopify_domain, s.code, shopLoc);
      // Duplikaty (dwa produkty Shopify na ten sam rozmiar): stan dostaje jeden, pozostałe 0 – bez sprzedaży dwa razy tej samej sztuki.
      const owner = new Map<string, string>();
      for (const l of [...links].sort((a, b) => a.shopify_inventory_item_id.localeCompare(b.shopify_inventory_item_id))) {
        if (levels.has(l.shopify_inventory_item_id) && !owner.has(l.variant_id)) owner.set(l.variant_id, l.shopify_inventory_item_id);
      }
      for (const l of links) {
        // Pozycja niepodpięta w tej lokalizacji Shopify – pomijamy (Shopify nie przyjmie stanu bez aktywacji).
        if (!levels.has(l.shopify_inventory_item_id)) continue;
        const current = levels.get(l.shopify_inventory_item_id)!;
        const target = owner.get(l.variant_id) === l.shopify_inventory_item_id ? want.get(`${l.variant_id}|${shopLoc}`) ?? 0 : 0;
        if (target > current && hold.has(l.variant_id)) continue;
        if (current !== target) changes.push({ inventoryItemId: l.shopify_inventory_item_id, locationId: shopLoc, quantity: target, changeFromQuantity: current });
      }
    }
    plan.push({ store: s, changes });
  }
  return plan;
}

/** Aplikacja jest główna: zapis stanów do Shopify (porcjami, z kontrolą, że stan w Shopify się w międzyczasie nie zmienił). */
export async function pushStockToShopify(db: SupabaseClient, maxChanges = 500) {
  const plan = await planPushToShopify(db);
  const results: Record<string, unknown> = {};
  for (const p of plan) {
    if (p.note) { results[p.store.name] = p.note; continue; }
    const todo = p.changes.slice(0, maxChanges);
    let done = 0;
    const errors: string[] = [];
    for (let i = 0; i < todo.length; i += 100) {
      const batch = todo.slice(i, i + 100);
      const data = await shopifyGraphql<{ inventorySetQuantities: { userErrors: { message: string; code: string | null }[] } }>(
        p.store.shopify_domain, p.store.code,
        `mutation Set($input: InventorySetQuantitiesInput!, $key: String!) { inventorySetQuantities(input: $input) @idempotent(key: $key) { inventoryAdjustmentGroup { id } userErrors { field message code } } }`,
        { key: crypto.randomUUID(), input: { name: "available", reason: "correction", referenceDocumentUri: "magazyn://stan-z-aplikacji", quantities: batch } },
      );
      const errs = data.inventorySetQuantities.userErrors;
      if (errs.length) errors.push(...errs.map((e) => e.message));
      else done += batch.length;
    }
    results[p.store.name] = { changed: done, left: p.changes.length - todo.length, ...(errors.length ? { errors: [...new Set(errors)].slice(0, 3) } : {}) };
  }
  return results;
}

/** Zadanie cykliczne: według głównego źródła. */
export async function syncStock(db: SupabaseClient) {
  const mapped = await autoMapLocations(db).catch(() => []);
  const master = await getStockMaster(db);
  const result = master === "app" ? await pushStockToShopify(db) : await reconcileFromShopify(db);
  return { master, ...(mapped.length ? { mapped } : {}), result };
}
