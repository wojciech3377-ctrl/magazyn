import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { shopifyGraphql } from "@/lib/integrations/shopify";
import { errorMessage } from "@/lib/errors";

/**
 * Stany magazynowe między aplikacją a Shopify. Główne źródło wybiera się w Ustawieniach:
 *  - "shopify": stan w Shopify → brakujące sztuki w Magazynie ,
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

export type Levels = Map<string, number> & { truncated?: boolean };

/**
 * Stan „dostępne” każdej pozycji magazynowej w lokalizacji Shopify: inventoryItemId → ilość.
 * Do 200 stron po 250 (50 000 pozycji) – wcześniej 40 stron (10 000) i w dużym sklepie najnowsze produkty
 * (np. pojedyncze używane pary) nie były w ogóle czytane, więc nie dostawały sztuk.
 */
export async function readLevels(domain: string, storeCode: string, locationId: string, maxPages = 200): Promise<Levels> {
  const out: Levels = new Map<string, number>();
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
    if (page === maxPages - 1) out.truncated = true;
  }
  return out;
}

/** mirror_of – sklep-kopia (SQL 78): stan = sztuki w lokalizacjach sklepu źródłowego, w jednej lokalizacji Shopify kopii. */
type Store = { id: string; code: string; name: string; shopify_domain: string; mirror_of?: string | null; mirror_location_id?: string | null };
type Loc = { id: string; store_id: string; shopify_location_id: string | null; active: boolean };
type Link = { variant_id: string; shopify_inventory_item_id: string };

async function storesAndLocations(db: SupabaseClient) {
  const [{ data: stores }, { data: locs }] = await Promise.all([
    db.from("stores").select("*").not("shopify_domain", "is", null),
    db.from("locations").select("id, store_id, shopify_location_id, active").order("created_at"),
  ]);
  return { stores: (stores ?? []) as Store[], locs: (locs ?? []) as Loc[] };
}

/**
 * Lokalizacje, z których liczy się stan sklepu, i lokalizacja Shopify każdej z nich. Sklep-kopia: lokalizacje
 * sklepu źródłowego → jedna lokalizacja Shopify kopii (te same sztuki co w źródle).
 */
function countingLocations(s: Store, locs: Loc[]) {
  if (s.mirror_of) {
    if (!s.mirror_location_id) return { mapped: [] as Loc[], shopLocOf: new Map<string, string>(), note: "sklep-kopia: wybierz lokalizację Shopify (Ustawienia → Sklepy i lokalizacje)" };
    const mapped = locs.filter((l) => l.store_id === s.mirror_of && l.active && l.shopify_location_id);
    return { mapped, shopLocOf: new Map(mapped.map((l) => [l.id, s.mirror_location_id!])), note: mapped.length ? null : "sklep źródłowy nie ma lokalizacji Shopify" };
  }
  const mapped = locs.filter((l) => l.store_id === s.id && l.active && l.shopify_location_id);
  return { mapped, shopLocOf: new Map(mapped.map((l) => [l.id, l.shopify_location_id!])), note: mapped.length ? null : "brak lokalizacji Shopify przy lokalizacjach aplikacji" };
}

/** Sklep z jedną aktywną lokalizacją Shopify i jedną lokalizacją w aplikacji – łączy je sam. */
export async function autoMapLocations(db: SupabaseClient) {
  const { stores, locs } = await storesAndLocations(db);
  const mapped: string[] = [];
  for (const s of stores) {
    // Sklep-kopia: jedna aktywna lokalizacja w jego Shopify → tam idzie stan.
    if (s.mirror_of) {
      if (s.mirror_location_id) continue;
      const shop = (await shopifyLocations(s.shopify_domain, s.code)).filter((l) => l.isActive);
      if (shop.length !== 1) continue;
      await db.from("stores").update({ mirror_location_id: shop[0].id }).eq("id", s.id);
      mapped.push(`${s.name}: ${shop[0].name}`);
      continue;
    }
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

/**
 * Sztuki na stanie w lokalizacjach (wariant × lokalizacja). Supabase oddaje najwyżej 1000 wierszy na zapytanie –
 * czytamy stronami. Wcześniej przy ponad 1000 rozmiarach na stanie reszta liczyła się jako 0, a zapis
 * „aplikacja → Shopify” zerował im stan na stronie.
 */
async function allStockCounts(db: SupabaseClient, locationIds: string[]) {
  const out: { variant_id: string; location_id: string; qty: number }[] = [];
  for (let from = 0; from < 1_000_000; from += 1000) {
    const { data, error } = await db.rpc("stock_counts", { p_location_ids: locationIds }).order("variant_id").order("location_id").range(from, from + 999);
    if (error) throw error;
    out.push(...((data ?? []) as typeof out));
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

/** Ujemny stan w Shopify (sprzedane ponad stan: −1, −2…) ustawiany na 0. Zwraca liczbę poprawionych pozycji. */
export async function zeroNegativeLevels(domain: string, storeCode: string, items: { inventoryItemId: string; locationId: string; qty: number }[]) {
  let fixed = 0;
  for (let i = 0; i < items.length; i += 100) {
    const batch = items.slice(i, i + 100).map((x) => ({ inventoryItemId: x.inventoryItemId, locationId: x.locationId, quantity: 0, changeFromQuantity: x.qty }));
    const data = await shopifyGraphql<{ inventorySetQuantities: { userErrors: { message: string }[] } }>(domain, storeCode,
      `mutation Set($input: InventorySetQuantitiesInput!, $key: String!) { inventorySetQuantities(input: $input) @idempotent(key: $key) { inventoryAdjustmentGroup { id } userErrors { field message } } }`,
      { key: crypto.randomUUID(), input: { name: "available", reason: "correction", referenceDocumentUri: "magazyn://ujemny-stan-na-zero", quantities: batch } });
    if (!data.inventorySetQuantities.userErrors.length) fixed += batch.length;
  }
  return fixed;
}

/**
 * Shopify jest główny: stan „dostępne” = stan w aplikacji. Brakujące sztuki dochodzą (nowy produkt od razu,
 * inne po potwierdzeniu przy kolejnym odczycie), nadmiarowe sztuki bez historii znikają po 30 min – patrz reconcile_stock.
 */
export async function reconcileFromShopify(db: SupabaseClient, opts: { force?: boolean } = {}) {
  const { stores, locs } = await storesAndLocations(db);
  const results: Record<string, unknown> = {};
  for (const s of stores) {
    // Sklep-kopia: stan zawsze z aplikacji (sztuki źródła) – bez odczytu jego Shopify do Magazynu.
    if (s.mirror_of) continue;
    const mapped = locs.filter((l) => l.store_id === s.id && l.active && l.shopify_location_id);
    if (!mapped.length) { results[s.name] = "brak lokalizacji Shopify przy lokalizacjach aplikacji"; continue; }
    // Błąd jednego sklepu (np. „za dużo na automat”) nie zatrzymuje drugiego – trafia do wyniku i „Błędów automatu”.
    try {
    const links = await trackedLinks(db, s.id);
    const variantOf = new Map(links.map((l) => [l.shopify_inventory_item_id, l.variant_id]));
    // Ten sam rozmiar w dwóch produktach Shopify (duplikat) – liczymy większy stan, nie sumę.
    const best = new Map<string, { variant_id: string; location_id: string; qty: number; count_locations: string[] }>();
    const perItem = new Map<string, number>();
    let truncated = false;
    const negatives: { inventoryItemId: string; locationId: string; qty: number }[] = [];
    for (const [shopLoc, group] of groupByShopLocation(mapped)) {
      const levels = await readLevels(s.shopify_domain, s.code, shopLoc);
      if (levels.truncated) truncated = true;
      for (const [item, qty] of levels) if (qty < 0) negatives.push({ inventoryItemId: item, locationId: shopLoc, qty });
      for (const [item, qty] of levels) perItem.set(item, (perItem.get(item) ?? 0) + Math.max(0, qty));
      for (const [item, qty] of levels) {
        const variantId = variantOf.get(item);
        if (!variantId) continue;
        const key = `${variantId}|${shopLoc}`;
        const prev = best.get(key);
        if (!prev || prev.qty < qty) best.set(key, { variant_id: variantId, location_id: group[0].id, qty: Math.max(0, qty), count_locations: group.map((g) => g.id) });
      }
    }
    const { data, error } = await db.rpc("reconcile_stock", {
      // Ręczne zatwierdzenie (po obejrzeniu porównania): bez limitu i bez czekania na potwierdzenie.
      // Magazyn = stan w Shopify: sztuki bez historii dochodzą / znikają bez limitu (po potwierdzeniu przy kolejnym odczycie),
      // własne sztuki z historią są wycofywane po 50 na raz; komisu automat nie rusza.
      p_rows: [...best.values()], p_limit: 100000, p_source: `Shopify ${s.name}`, p_scope: mapped.map((l) => l.id),
      p_confirm_minutes: opts.force ? 0 : 10,
      p_remove: true, p_surplus_minutes: opts.force ? 0 : 30, p_history_limit: opts.force ? 100000 : 50,
    });
    if (error) throw error;
    const zeroed = negatives.length ? await zeroNegativeLevels(s.shopify_domain, s.code, negatives).catch(() => 0) : 0;
    results[s.name] = { ...(data as object), levels: perItem.size, ...(zeroed ? { ujemne_na_zero: zeroed } : {}), ...(truncated ? { uwaga: "Shopify ma ponad 50 000 pozycji w lokalizacji – część nie została odczytana" } : {}) };
    // Stan ze Shopify przy rozmiarze (Katalog) – tylko zmienione.
    const rows = [...perItem.entries()].map(([item, qty]) => ({ item, qty }));
    for (let i = 0; i < rows.length; i += 2000) await db.rpc("set_shopify_qty", { p_store_id: s.id, p_rows: rows.slice(i, i + 2000) }).then(() => null, () => null);
    } catch (e) {
      results[s.name] = `błąd: ${e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e)}`;
    }
  }
  return results;
}

/**
 * Zmiana stanu z webhooka inventory_levels/update (tylko gdy Shopify jest główny). Zupełnie nowy produkt dostaje
 * sztuki od razu; przy pozostałych nadwyżka czeka na potwierdzenie przy odczycie co 15 min.
 */
export async function reconcileShopifyLevel(db: SupabaseClient, storeId: string, inventoryItemId: string, locationId: string, available: number) {
  const { data: self } = await db.from("stores").select("*").eq("id", storeId).maybeSingle();
  if ((self as Store | null)?.mirror_of) return null; // sklep-kopia – stany tylko z aplikacji
  const master = await getStockMaster(db);
  // Aplikacja główna: tylko zupełnie nowy produkt (rozmiar bez żadnej sztuki w historii) dostaje sztuki od razu.
  if (master === "app" && available > 0) return seedNewVariantLevel(db, storeId, inventoryItemId, locationId, available);
  if (master !== "shopify" || available <= 0) {
    // Sprzedane ponad stan (−1, −2…) – w Shopify od razu 0.
    if (available < 0) {
      const { data: st } = await db.from("stores").select("code, shopify_domain").eq("id", storeId).maybeSingle();
      if (st?.shopify_domain) await zeroNegativeLevels(st.shopify_domain as string, st.code as string, [{ inventoryItemId, locationId, qty: available }]).catch(() => 0);
    }
    return null;
  }
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
/** Rozmiar bez stanu w danej lokalizacji Shopify (nieaktywny), a aplikacja ma tam sztuki – do aktywacji ze stanem. */
type Activation = { inventoryItemId: string; locationId: string; quantity: number };

/**
 * Aktywacja rozmiarów w lokalizacji Shopify (np. nowy sklep) od razu z ilością „dostępne”.
 * Bez tego Shopify nie przyjmuje stanu, więc sztuki z nowego sklepu nie byłyby widoczne na stronie.
 */
export async function activateAtLocation(domain: string, storeCode: string, items: Activation[]) {
  let done = 0;
  const errors: string[] = [];
  for (const a of items) {
    try {
      const d = await shopifyGraphql<{ inventoryActivate: { userErrors: { message: string }[] } }>(domain, storeCode,
        `mutation Act($item: ID!, $loc: ID!, $qty: Int, $key: String!) { inventoryActivate(inventoryItemId: $item, locationId: $loc, available: $qty) @idempotent(key: $key) { inventoryLevel { id } userErrors { field message } } }`,
        { item: a.inventoryItemId, loc: a.locationId, qty: a.quantity, key: crypto.randomUUID() });
      const err = d.inventoryActivate.userErrors.map((e) => e.message).join("; ");
      if (err) errors.push(err); else done++;
    } catch (e) {
      errors.push(errorMessage(e));
    }
  }
  return { done, errors };
}

/** Różnice, gdyby aplikacja była główna: ile pozycji w Shopify trzeba zmienić (bez zapisu). */
export async function planPushToShopify(db: SupabaseClient, onlyVariants?: Set<string>, opts: { seed?: boolean; onlyStores?: Set<string> } = {}) {
  const { stores, locs } = await storesAndLocations(db);
  const plan: { store: Store; changes: Change[]; activate: Activation[]; note?: string; seeded?: number; waitingMatch?: number; seedError?: string }[] = [];
  for (const s of stores) {
    if (opts.onlyStores && !opts.onlyStores.has(s.id)) continue;
    const { mapped, shopLocOf, note } = countingLocations(s, locs);
    if (note) { plan.push({ store: s, changes: [], activate: [], note }); continue; }
    const links = await trackedLinks(db, s.id);
    const counts = await allStockCounts(db, mapped.map((l) => l.id));
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
    const activate: Activation[] = [];
    // Nowe rozmiary, którym nie udało się dodać sztuk – nie zerujemy ich w Shopify (lepiej sprzedać niż ukryć).
    const protect = new Set<string>();
    let seeded = 0;
    let waitingMatch = 0;
    let seedError: string | undefined;
    for (const shopLoc of new Set(shopLocOf.values())) {
      const levels = await readLevels(s.shopify_domain, s.code, shopLoc);
      // Duplikaty (dwa produkty Shopify na ten sam rozmiar): stan dostaje jeden, pozostałe 0 – bez sprzedaży dwa razy tej samej sztuki.
      const owner = new Map<string, string>();
      for (const l of [...links].sort((a, b) => a.shopify_inventory_item_id.localeCompare(b.shopify_inventory_item_id))) {
        if (levels.has(l.shopify_inventory_item_id) && !owner.has(l.variant_id)) owner.set(l.variant_id, l.shopify_inventory_item_id);
      }
      // Nowy produkt dodany w Shopify (rozmiar, który nigdy nie miał sztuk w aplikacji) ze stanem > 0:
      // zamiast zerować stan w Shopify – sztuki w Magazynie (własne, bez umowy; umowę przypniesz później).
      // Sklep-kopia nie zasila Magazynu (produkty i stany pochodzą ze źródła).
      if (opts.seed && !s.mirror_of) {
        const group = mapped.filter((l) => l.shopify_location_id === shopLoc);
        const cand = [...owner.entries()]
          .map(([variant_id, item]) => ({ variant_id, qty: levels.get(item) ?? 0 }))
          .filter((c) => c.qty > 0 && !(want.get(`${c.variant_id}|${shopLoc}`) ?? 0) && (!onlyVariants || onlyVariants.has(c.variant_id)));
        const fresh: typeof cand = [];
        for (let i = 0; i < cand.length; i += 200) {
          const part = cand.slice(i, i + 200);
          const { data: had } = await db.from("units").select("variant_id").in("variant_id", part.map((c) => c.variant_id));
          const hadSet = new Set((had ?? []).map((u) => u.variant_id as string));
          fresh.push(...part.filter((c) => !hadSet.has(c.variant_id)));
        }
        // Pasuje do rzeczy z umowy „nieprzypisanej do Shopify” – bez nowych sztuk (podpowiedź do ręcznego zatwierdzenia
        // w Do zrobienia / na karcie sztuki); stanu w Shopify też nie zerujemy.
        if (fresh.length) {
          const { unassignedRefs, matchesUnassigned } = await import("@/lib/unassigned");
          const refs = await unassignedRefs(db);
          if (refs.length) {
            const names = new Map<string, { title: string; option: string }>();
            const ids = fresh.map((c) => c.variant_id);
            for (let i = 0; i < ids.length; i += 200) {
              const { data } = await db.from("variants").select("id, option, product:products(title)").in("id", ids.slice(i, i + 200));
              for (const v of data ?? []) names.set(v.id as string, { title: (v.product as unknown as { title: string } | null)?.title ?? "", option: v.option as string });
            }
            for (let i = fresh.length - 1; i >= 0; i--) {
              const n = names.get(fresh[i].variant_id);
              if (n && matchesUnassigned(refs, n.title, n.option)) { protect.add(fresh[i].variant_id); waitingMatch++; fresh.splice(i, 1); }
            }
          }
        }
        if (fresh.length) {
          const { data, error } = await db.rpc("reconcile_stock", {
            p_rows: fresh.map((c) => ({ variant_id: c.variant_id, location_id: group[0].id, qty: c.qty, count_locations: group.map((g) => g.id) })),
            p_limit: 500, p_source: `Shopify ${s.name} (nowy produkt)`, p_scope: null, p_confirm_minutes: 0, p_remove: false,
          });
          fresh.forEach((c) => protect.add(c.variant_id));
          if (error) seedError = error.message;
          else {
            seeded += Number((data as { created?: number } | null)?.created ?? 0);
            // Stan aplikacji po dodaniu – żeby zapis do Shopify go nie wyzerował.
            const ids = fresh.map((c) => c.variant_id);
            for (let i = 0; i < ids.length; i += 200) {
              const { data: now } = await db.from("units").select("variant_id, location_id").in("variant_id", ids.slice(i, i + 200)).eq("status", "in_stock");
              for (const u of now ?? []) {
                const key = `${u.variant_id}|${shopLocOf.get(u.location_id as string)}`;
                if (shopLocOf.has(u.location_id as string)) want.set(key, (want.get(key) ?? 0) + 1);
                protect.delete(u.variant_id as string);
              }
            }
          }
        }
      }
      for (const l of links) {
        if (onlyVariants && !onlyVariants.has(l.variant_id)) continue;
        // Pozycja niepodpięta w tej lokalizacji Shopify (np. nowy sklep): gdy aplikacja ma tu sztuki – aktywacja ze stanem
        // (jedna pozycja na rozmiar, przy duplikatach pierwsza wg ID). Bez sztuk – pomijamy.
        if (!levels.has(l.shopify_inventory_item_id)) {
          if (owner.has(l.variant_id) || protect.has(l.variant_id) || hold.has(l.variant_id)) continue;
          const qty = want.get(`${l.variant_id}|${shopLoc}`) ?? 0;
          if (qty > 0) { owner.set(l.variant_id, l.shopify_inventory_item_id); activate.push({ inventoryItemId: l.shopify_inventory_item_id, locationId: shopLoc, quantity: qty }); }
          continue;
        }
        const current = levels.get(l.shopify_inventory_item_id)!;
        const target = owner.get(l.variant_id) === l.shopify_inventory_item_id ? want.get(`${l.variant_id}|${shopLoc}`) ?? 0 : 0;
        if (target > current && hold.has(l.variant_id)) continue;
        if (protect.has(l.variant_id)) continue;
        if (current !== target) changes.push({ inventoryItemId: l.shopify_inventory_item_id, locationId: shopLoc, quantity: target, changeFromQuantity: current });
      }
    }
    plan.push({ store: s, changes, activate, ...(seeded ? { seeded } : {}), ...(waitingMatch ? { waitingMatch } : {}), ...(seedError ? { seedError } : {}) });
  }
  return plan;
}

/** Aplikacja jest główna: zapis stanów do Shopify (porcjami, z kontrolą, że stan w Shopify się w międzyczasie nie zmienił). */
export async function pushStockToShopify(db: SupabaseClient, maxChanges = 500, onlyVariants?: Set<string>, opts: { onlyStores?: Set<string> } = {}) {
  const plan = await planPushToShopify(db, onlyVariants, { seed: true, onlyStores: opts.onlyStores });
  const results: Record<string, unknown> = {};
  for (const p of plan) {
    if (p.note) { results[p.store.name] = p.note; continue; }
    const seededInfo = { ...(p.seeded ? { nowe_ze_shopify: p.seeded } : {}), ...(p.waitingMatch ? { pasuje_do_nieprzypisanych: p.waitingMatch } : {}), ...(p.seedError ? { blad_nowych: p.seedError } : {}) };
    const todo = p.changes.slice(0, maxChanges);
    let done = 0;
    const errors: string[] = [];
    const send = (batch: Change[]) => shopifyGraphql<{ inventorySetQuantities: { userErrors: { message: string; code: string | null }[] } }>(
      p.store.shopify_domain, p.store.code,
      `mutation Set($input: InventorySetQuantitiesInput!, $key: String!) { inventorySetQuantities(input: $input) @idempotent(key: $key) { inventoryAdjustmentGroup { id } userErrors { field message code } } }`,
      { key: crypto.randomUUID(), input: { name: "available", reason: "correction", referenceDocumentUri: "magazyn://stan-z-aplikacji", quantities: batch } },
    );
    for (let i = 0; i < todo.length; i += 100) {
      const batch = todo.slice(i, i + 100);
      // Błąd sieci / Shopify dla całej paczki: zapis z changeFromQuantity jest bezpieczny do ponowienia – pozycja po pozycji.
      const errs = await send(batch).then((r) => r.inventorySetQuantities.userErrors, (e) => [{ message: String(e), code: null }]);
      if (!errs.length) { done += batch.length; continue; }
      // Jedna zła pozycja blokuje całą paczkę – wtedy pozycja po pozycji, żeby reszta się zapisała.
      for (const one of batch) {
        const e1 = (await send([one]).catch((e) => ({ inventorySetQuantities: { userErrors: [{ message: String(e), code: null }] } }))).inventorySetQuantities.userErrors;
        if (e1.length) errors.push(...e1.map((e) => e.message));
        else done++;
      }
    }
    // Rozmiary nieaktywne w lokalizacji Shopify, a z sztukami w aplikacji (np. nowy sklep) – aktywacja ze stanem, porcjami.
    const toActivate = p.activate.slice(0, maxChanges);
    const act = toActivate.length ? await activateAtLocation(p.store.shopify_domain, p.store.code, toActivate) : null;
    if (act) errors.push(...act.errors);
    results[p.store.name] = { changed: done, left: p.changes.length - todo.length, ...(act ? { aktywowane: act.done, do_aktywacji: p.activate.length - toActivate.length } : {}), ...seededInfo, ...(errors.length ? { failed: errors.length, errors: [...new Set(errors)].slice(0, 3) } : {}) };
  }
  return results;
}

/** Zadanie cykliczne: według głównego źródła. */
export async function syncStock(db: SupabaseClient, opts: { force?: boolean } = {}) {
  const mapped = await autoMapLocations(db).catch(() => []);
  const master = await getStockMaster(db);
  const result = master === "app" ? await pushStockToShopify(db) : await reconcileFromShopify(db, opts);
  // Główny Shopify: sklepy-kopie i tak dostają stan z aplikacji (sztuki sklepu źródłowego).
  if (master !== "app") {
    const { stores } = await storesAndLocations(db);
    const mirrors = new Set(stores.filter((s) => s.mirror_of).map((s) => s.id));
    if (mirrors.size) Object.assign(result as object, await pushStockToShopify(db, 500, undefined, { onlyStores: mirrors }).catch((e) => ({ kopie: errorMessage(e) })));
  }
  return { master, ...(mapped.length ? { mapped } : {}), result };
}

export type StockDiff = { store: string; title: string; option: string; shopify: number; app: number; waitingSince: string | null };

/** Porównanie stanu Shopify ↔ aplikacja (rozmiary, które się różnią) – do podglądu w Ustawieniach. */
export async function compareStock(db: SupabaseClient, limit = 300) {
  const { stores, locs } = await storesAndLocations(db);
  const diffs: (Omit<StockDiff, "title" | "option"> & { variantId: string; locationId: string })[] = [];
  const notes: string[] = [];
  for (const s of stores) {
    const { mapped, shopLocOf, note } = countingLocations(s, locs);
    if (note) { notes.push(`${s.name}: ${note}`); continue; }
    const links = await trackedLinks(db, s.id);
    const counts = await allStockCounts(db, mapped.map((l) => l.id));
    const byShop = new Map<string, Loc[]>();
    for (const l of mapped) byShop.set(shopLocOf.get(l.id)!, [...(byShop.get(shopLocOf.get(l.id)!) ?? []), l]);
    for (const [shopLoc, group] of byShop) {
      const levels = await readLevels(s.shopify_domain, s.code, shopLoc);
      const ids = new Set(group.map((g) => g.id));
      const app = new Map<string, number>();
      for (const c of (counts ?? []) as { variant_id: string; location_id: string; qty: number }[]) if (ids.has(c.location_id)) app.set(c.variant_id, (app.get(c.variant_id) ?? 0) + c.qty);
      const shop = new Map<string, number>();
      for (const l of links) if (levels.has(l.shopify_inventory_item_id)) shop.set(l.variant_id, Math.max(shop.get(l.variant_id) ?? 0, levels.get(l.shopify_inventory_item_id)!));
      for (const v of new Set([...shop.keys(), ...app.keys()])) {
        const a = app.get(v) ?? 0;
        const sh = shop.get(v);
        if (sh === undefined || sh === a) continue;
        diffs.push({ store: s.name, variantId: v, locationId: group[0].id, shopify: Math.max(0, sh), app: a, waitingSince: null });
      }
    }
  }
  const top = diffs.slice(0, limit);
  const vids = [...new Set(top.map((d) => d.variantId))];
  const names = new Map<string, { title: string; option: string }>();
  for (let i = 0; i < vids.length; i += 150) {
    const { data } = await db.from("variants").select("id, option, product:products(title)").in("id", vids.slice(i, i + 150));
    for (const v of data ?? []) names.set(v.id as string, { title: (v.product as unknown as { title: string } | null)?.title ?? "", option: v.option as string });
  }
  const { data: waiting } = vids.length ? await db.from("stock_excess").select("variant_id, location_id, first_seen_at").in("variant_id", vids) : { data: [] };
  const since = new Map((waiting ?? []).map((w) => [`${w.variant_id}|${w.location_id}`, w.first_seen_at as string]));
  return {
    total: diffs.length,
    notes,
    rows: top.map((d): StockDiff => ({ store: d.store, ...(names.get(d.variantId) ?? { title: "?", option: "" }), shopify: d.shopify, app: d.app, waitingSince: since.get(`${d.variantId}|${d.locationId}`) ?? null }))
      .sort((a, b) => a.title.localeCompare(b.title, "pl")),
  };
}

/**
 * Szybki odczyt stanów: tylko pozycje zmienione w Shopify od ostatniego sprawdzenia (zapytanie z filtrem updated_at),
 * zamiast całego magazynu (10 000+ pozycji). Działa co minutę i „na żywo”, gdy aplikacja jest otwarta.
 */
export async function reconcileRecentFromShopify(db: SupabaseClient) {
  if ((await getStockMaster(db)) !== "shopify") return { skipped: "główny jest magazyn aplikacji" };
  const { stores, locs } = await storesAndLocations(db);
  const out: Record<string, unknown> = {};
  for (const s of stores) {
    // Błąd jednego sklepu nie zatrzymuje drugiego.
    try {
    if (s.mirror_of) continue; // sklep-kopia – stany tylko z aplikacji
    const mapped = locs.filter((l) => l.store_id === s.id && l.active && l.shopify_location_id);
    if (!mapped.length) continue;
    const key = `stock_live:${s.id}`;
    const { data: st } = await db.from("sync_state").select("value").eq("key", key).maybeSingle();
    const since = (st?.value as { since?: string } | null)?.since ?? new Date(Date.now() - 15 * 60_000).toISOString();
    const startedAt = new Date(Date.now() - 5_000).toISOString();
    const changed = new Map<string, { qty: number; shopLoc: string }>();
    const negatives: { inventoryItemId: string; locationId: string; qty: number }[] = [];
    for (const [shopLoc] of groupByShopLocation(mapped)) {
      let after: string | null = null;
      for (let page = 0; page < 20; page++) {
        const data: { location: { inventoryLevels: { nodes: { item: { id: string } | null; quantities: { quantity: number }[] }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } | null } =
          await shopifyGraphql(s.shopify_domain, s.code,
            `query Levels($id: ID!, $after: String, $q: String) { location(id: $id) { inventoryLevels(first: 250, after: $after, query: $q) { nodes { item { id } quantities(names: ["available"]) { quantity } } pageInfo { hasNextPage endCursor } } } }`,
            { id: shopLoc, after, q: `updated_at:>='${since}'` });
        const lv = data.location?.inventoryLevels;
        if (!lv) break;
        for (const n of lv.nodes) {
          if (!n.item) continue;
          const qty = n.quantities[0]?.quantity ?? 0;
          changed.set(`${n.item.id}|${shopLoc}`, { qty, shopLoc });
          if (qty < 0) negatives.push({ inventoryItemId: n.item.id, locationId: shopLoc, qty });
        }
        if (!lv.pageInfo.hasNextPage) break;
        after = lv.pageInfo.endCursor;
      }
    }
    if (negatives.length) await zeroNegativeLevels(s.shopify_domain, s.code, negatives).catch(() => 0);
    let result: unknown = { changed: 0 };
    if (changed.size) {
      const items = [...new Set([...changed.keys()].map((k) => k.split("|")[0]))];
      const links: { variant_id: string; shopify_inventory_item_id: string }[] = [];
      for (let i = 0; i < items.length; i += 200) {
        const { data } = await db.from("variant_store_links").select("variant_id, shopify_inventory_item_id").eq("store_id", s.id).eq("inventory_tracked", true).in("shopify_inventory_item_id", items.slice(i, i + 200));
        links.push(...((data ?? []) as typeof links));
      }
      // Rozmiar w kilku produktach Shopify naraz (duplikat) – liczy pełny odczyt, tu pomijamy.
      const perVariant = new Map<string, number>();
      for (const l of links) perVariant.set(l.variant_id, (perVariant.get(l.variant_id) ?? 0) + 1);
      const { data: multi } = perVariant.size ? await db.from("variant_store_links").select("variant_id").eq("store_id", s.id).in("variant_id", [...perVariant.keys()].slice(0, 500)) : { data: [] };
      const count = new Map<string, number>();
      for (const m of multi ?? []) count.set(m.variant_id as string, (count.get(m.variant_id as string) ?? 0) + 1);
      const groups = groupByShopLocation(mapped);
      const rows = links.filter((l) => (count.get(l.variant_id) ?? 1) === 1).flatMap((l) => {
        const out2: { variant_id: string; location_id: string; qty: number; count_locations: string[] }[] = [];
        for (const [shopLoc, group] of groups) {
          const c = changed.get(`${l.shopify_inventory_item_id}|${shopLoc}`);
          if (c) out2.push({ variant_id: l.variant_id, location_id: group[0].id, qty: Math.max(0, c.qty), count_locations: group.map((g) => g.id) });
        }
        return out2;
      });
      if (rows.length) {
        const { data, error } = await db.rpc("reconcile_stock", {
          p_rows: rows, p_limit: 500, p_source: `Shopify ${s.name}`, p_scope: null,
          p_confirm_minutes: 10, p_remove: true, p_surplus_minutes: 30, p_history_limit: 50,
        });
        if (error) throw error;
        result = { changed: rows.length, ...(data as object) };
      }
      const perItem = items.map((item) => ({ item, qty: [...changed.entries()].filter(([k]) => k.startsWith(`${item}|`)).reduce((n, [, v]) => n + Math.max(0, v.qty), 0) }));
      for (let i = 0; i < perItem.length; i += 2000) await db.rpc("set_shopify_qty", { p_store_id: s.id, p_rows: perItem.slice(i, i + 2000) }).then(() => null, () => null);
    }
    await db.from("sync_state").upsert({ key, value: { since: startedAt }, updated_at: new Date().toISOString() });
    out[s.name] = result;
    } catch (e) {
      out[s.name] = `błąd: ${errorMessage(e)}`;
    }
  }
  return out;
}

/** Aplikacja główna, webhook stanu: nowy produkt ze Shopify (bez sztuk w historii) → sztuki w Magazynie od razu. */
async function seedNewVariantLevel(db: SupabaseClient, storeId: string, inventoryItemId: string, locationId: string, available: number) {
  const [{ data: links }, { data: group }] = await Promise.all([
    db.from("variant_store_links").select("variant_id").eq("store_id", storeId).eq("shopify_inventory_item_id", inventoryItemId).eq("inventory_tracked", true).limit(1),
    db.from("locations").select("id").eq("store_id", storeId).eq("active", true).eq("shopify_location_id", locationId).order("created_at"),
  ]);
  const link = links?.[0];
  if (!link || !group?.length) return null;
  const { count } = await db.from("units").select("id", { count: "exact", head: true }).eq("variant_id", link.variant_id);
  if (count) return null;
  // Pasuje do rzeczy z umowy „nieprzypisanej do Shopify” – czeka na ręczne zatwierdzenie (Do zrobienia).
  const { unassignedRefs, matchesUnassigned } = await import("@/lib/unassigned");
  const { data: v } = await db.from("variants").select("option, product:products(title)").eq("id", link.variant_id).maybeSingle();
  if (v && matchesUnassigned(await unassignedRefs(db), (v.product as unknown as { title: string } | null)?.title ?? "", v.option as string)) return { waiting: "pasuje do rzeczy nieprzypisanej" };
  const { data: store } = await db.from("stores").select("name").eq("id", storeId).maybeSingle();
  const { data, error } = await db.rpc("reconcile_stock", {
    p_rows: [{ variant_id: link.variant_id, location_id: group[0].id, qty: available, count_locations: group.map((g) => g.id) }],
    p_limit: 100, p_source: `Shopify ${store?.name ?? ""} (nowy produkt)`.trim(), p_scope: null, p_confirm_minutes: 0, p_remove: false,
  });
  if (error) throw error;
  return data;
}

/**
 * Szybki zapis stanu wybranych rozmiarów (bez czytania całej lokalizacji): po zamówieniu, anulowaniu albo ruchu
 * w aplikacji – żeby drugi sklep (np. kopia Owca Store ↔ Sneakers Depot) od razu pokazał ten sam stan.
 * Stan = sztuki na stanie w lokalizacjach liczonych dla sklepu. Rozmiary z zamówieniem w tym sklepie w ostatnich
 * 30 min nie dostają podniesienia stanu (zamówienie mogło jeszcze nie zdjąć sztuki).
 */
export async function pushVariantsNow(db: SupabaseClient, variantIds: string[], opts: { mirrorsOnly?: boolean } = {}) {
  const ids = [...new Set(variantIds)].filter(Boolean);
  const out: Record<string, unknown> = {};
  if (!ids.length) return out;
  const { stores, locs } = await storesAndLocations(db);
  for (const s of stores) {
    if (opts.mirrorsOnly && !s.mirror_of) continue;
    try {
      const { mapped, shopLocOf, note } = countingLocations(s, locs);
      if (note) continue;
      // Powiązania rozmiarów w tym sklepie (pierwsza pozycja wg ID – jak przy pełnym zapisie, duplikaty dostają 0).
      const links: Link[] = [];
      for (let i = 0; i < ids.length; i += 150) {
        const { data } = await db.from("variant_store_links").select("variant_id, shopify_inventory_item_id").eq("store_id", s.id).eq("inventory_tracked", true)
          .not("shopify_inventory_item_id", "is", null).in("variant_id", ids.slice(i, i + 150));
        links.push(...((data ?? []) as Link[]));
      }
      if (!links.length) continue;
      const want = new Map<string, number>();
      for (let i = 0; i < ids.length; i += 150) {
        const { data } = await db.from("units").select("variant_id, location_id").eq("status", "in_stock").in("variant_id", ids.slice(i, i + 150)).in("location_id", mapped.map((l) => l.id));
        for (const u of data ?? []) {
          const key = `${u.variant_id}|${shopLocOf.get(u.location_id as string)}`;
          want.set(key, (want.get(key) ?? 0) + 1);
        }
      }
      const { data: recent } = await db.from("orders").select("line_items").eq("store_id", s.id).gte("ordered_at", new Date(Date.now() - 30 * 60_000).toISOString());
      const recentGids = new Set(((recent ?? []) as { line_items: { shopify_variant_id: string | null }[] }[]).flatMap((o) => o.line_items.map((l) => l.shopify_variant_id)).filter(Boolean) as string[]);
      const { data: held } = recentGids.size ? await db.from("variant_store_links").select("variant_id").eq("store_id", s.id).in("shopify_variant_id", [...recentGids]) : { data: [] };
      const hold = new Set((held ?? []).map((h) => h.variant_id as string));
      // Aktualny stan w Shopify tych pozycji.
      const levels = new Map<string, number>(); // `${item}|${loc}` → ilość
      const items = [...new Set(links.map((l) => l.shopify_inventory_item_id))];
      for (let i = 0; i < items.length; i += 100) {
        const d = await shopifyGraphql<{ nodes: ({ id: string; inventoryLevels: { nodes: { location: { id: string }; quantities: { quantity: number }[] }[] } } | null)[] }>(s.shopify_domain, s.code,
          `query L($ids: [ID!]!) { nodes(ids: $ids) { ... on InventoryItem { id inventoryLevels(first: 20) { nodes { location { id } quantities(names: ["available"]) { quantity } } } } } }`,
          { ids: items.slice(i, i + 100) });
        for (const n of d.nodes) if (n?.inventoryLevels) for (const lv of n.inventoryLevels.nodes) levels.set(`${n.id}|${lv.location.id}`, lv.quantities[0]?.quantity ?? 0);
      }
      const changes: Change[] = [];
      const activate: Activation[] = [];
      for (const shopLoc of new Set(shopLocOf.values())) {
        const owner = new Map<string, string>();
        for (const l of [...links].sort((a, b) => a.shopify_inventory_item_id.localeCompare(b.shopify_inventory_item_id))) {
          if (levels.has(`${l.shopify_inventory_item_id}|${shopLoc}`) && !owner.has(l.variant_id)) owner.set(l.variant_id, l.shopify_inventory_item_id);
        }
        for (const l of links) {
          const key = `${l.shopify_inventory_item_id}|${shopLoc}`;
          const target = want.get(`${l.variant_id}|${shopLoc}`) ?? 0;
          if (!levels.has(key)) {
            if (!owner.has(l.variant_id) && target > 0 && !hold.has(l.variant_id)) { owner.set(l.variant_id, l.shopify_inventory_item_id); activate.push({ inventoryItemId: l.shopify_inventory_item_id, locationId: shopLoc, quantity: target }); }
            continue;
          }
          const current = levels.get(key)!;
          const t = owner.get(l.variant_id) === l.shopify_inventory_item_id ? target : 0;
          if (t > current && hold.has(l.variant_id)) continue;
          if (t !== current) changes.push({ inventoryItemId: l.shopify_inventory_item_id, locationId: shopLoc, quantity: t, changeFromQuantity: current });
        }
      }
      let done = 0;
      const errors: string[] = [];
      for (let i = 0; i < changes.length; i += 100) {
        const d = await shopifyGraphql<{ inventorySetQuantities: { userErrors: { message: string }[] } }>(s.shopify_domain, s.code,
          `mutation Set($input: InventorySetQuantitiesInput!, $key: String!) { inventorySetQuantities(input: $input) @idempotent(key: $key) { inventoryAdjustmentGroup { id } userErrors { field message } } }`,
          { key: crypto.randomUUID(), input: { name: "available", reason: "correction", referenceDocumentUri: "magazyn://stan-z-aplikacji", quantities: changes.slice(i, i + 100) } });
        if (d.inventorySetQuantities.userErrors.length) errors.push(...d.inventorySetQuantities.userErrors.map((e) => e.message));
        else done += changes.slice(i, i + 100).length;
      }
      const act = activate.length ? await activateAtLocation(s.shopify_domain, s.code, activate) : null;
      if (act) errors.push(...act.errors);
      if (done || act?.done || errors.length) out[s.name] = { changed: done, ...(act?.done ? { aktywowane: act.done } : {}), ...(errors.length ? { errors: [...new Set(errors)].slice(0, 3) } : {}) };
    } catch (e) {
      out[s.name] = `błąd: ${errorMessage(e)}`;
    }
  }
  return out;
}

/** Czy są sklepy-kopie (szybkie sprawdzenie przed dodatkowym zapisem stanów). */
export async function hasMirrorStores(db: SupabaseClient) {
  const { data } = await db.from("stores").select("*").not("shopify_domain", "is", null);
  return ((data ?? []) as Store[]).some((s) => s.mirror_of);
}
