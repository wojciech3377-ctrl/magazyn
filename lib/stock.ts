import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { shopifyGraphql } from "@/lib/integrations/shopify";
import { errorMessage } from "@/lib/errors";

export type StockChange = { variantId: string; locationId: string; delta: number };

/**
 * Zmiana stanu po ruchu w aplikacji (kasa, faktura, dostawa, zwrot, przesunięcie, usunięcie):
 * zmiana o deltę w Shopify (lokalizacja Shopify przypisana do lokalizacji aplikacji).
 * Wynik ok = Shopify zaktualizowany; zmiany z błędem można ponowić bez ryzyka podwójnej zmiany.
 */
export async function adjustStock(db: SupabaseClient, changes: StockChange[]) {
  const merged = new Map<string, StockChange>();
  for (const c of changes) {
    const k = `${c.variantId}|${c.locationId}`;
    const prev = merged.get(k);
    merged.set(k, { ...c, delta: (prev?.delta ?? 0) + c.delta });
  }
  const todo = [...merged.values()].filter((c) => c.delta !== 0);
  const results: (StockChange & { ok: boolean; message: string })[] = [];
  if (!todo.length) return results;

  // Lokalizacje i powiązania naraz (wcześniej 2–3 zapytania na każdą zmianę).
  type Loc = { id: string; name: string; shopify_location_id: string | null; store: { id: string; name: string; code: string; shopify_domain: string | null } | null };
  const locIds = [...new Set(todo.map((c) => c.locationId))];
  const variantIds = [...new Set(todo.map((c) => c.variantId))];
  const [{ data: locRows }, { data: linkRows }] = await Promise.all([
    db.from("locations").select("id, name, shopify_location_id, store:stores(id, name, code, shopify_domain)").in("id", locIds),
    db.from("variant_store_links").select("variant_id, store_id, shopify_inventory_item_id, inventory_tracked")
      .in("variant_id", variantIds).not("shopify_inventory_item_id", "is", null)
      .order("inventory_tracked", { ascending: false }).order("shopify_inventory_item_id"),
  ]);
  const locs = new Map(((locRows ?? []) as unknown as Loc[]).map((l) => [l.id, l]));
  // Duplikaty powiązań (ten sam rozmiar dwa razy w sklepie): pierwszeństwo śledzonego, potem stała kolejność.
  const linkOf = new Map<string, string>();
  for (const l of linkRows ?? []) {
    const k = `${l.variant_id}|${l.store_id}`;
    if (!linkOf.has(k)) linkOf.set(k, l.shopify_inventory_item_id as string);
  }

  // Zmiany pogrupowane per sklep; ta sama pozycja Shopify (np. dwie lokalizacje aplikacji → jedna w Shopify) sumowana.
  type Item = { item: string; location: string; delta: number; src: StockChange[] };
  const perStore = new Map<string, { store: NonNullable<Loc["store"]>; items: Map<string, Item> }>();
  let unassignedChecked: Set<string> | null = null;
  for (const c of todo) {
    const loc = locs.get(c.locationId);
    const fail = (message: string) => results.push({ ...c, ok: false, message });
    if (!loc) { fail("nie znaleziono lokalizacji"); continue; }
    const store = loc.store;
    if (!store) { fail(`lokalizacja „${loc.name}” nie ma sklepu`); continue; }
    if (!store.shopify_domain) { fail(`sklep ${store.name} nie ma domeny Shopify`); continue; }
    if (!loc.shopify_location_id) { fail(`lokalizacja „${loc.name}” nie ma przypisanej lokalizacji Shopify (Ustawienia → Stany magazynowe)`); continue; }
    const item = linkOf.get(`${c.variantId}|${store.id}`);
    if (!item) {
      // Produkt „nieprzypisany do Shopify” (spoza katalogu) – nie ma czego zmieniać, dojdzie po przypisaniu.
      if (!unassignedChecked) {
        const { data: un } = await db.from("variants").select("id, product:products!inner(unassigned)").in("id", variantIds).eq("product.unassigned", true);
        unassignedChecked = new Set((un ?? []).map((v) => v.id as string));
      }
      if (unassignedChecked.has(c.variantId)) results.push({ ...c, ok: true, message: "nieprzypisany do Shopify – bez zmiany stanu" });
      else fail(`ten rozmiar nie ma wariantu w Shopify ${store.name}`);
      continue;
    }
    const group = perStore.get(store.id) ?? { store, items: new Map<string, Item>() };
    perStore.set(store.id, group);
    const k = `${item}|${loc.shopify_location_id}`;
    const it = group.items.get(k) ?? { item, location: loc.shopify_location_id, delta: 0, src: [] };
    it.delta += c.delta;
    it.src.push(c);
    group.items.set(k, it);
  }

  const send = (store: NonNullable<Loc["store"]>, items: Item[]) => shopifyGraphql<{ inventoryAdjustQuantities: { userErrors: { message: string }[] } }>(
    store.shopify_domain!, store.code,
    `mutation Adj($input: InventoryAdjustQuantitiesInput!, $key: String!) { inventoryAdjustQuantities(input: $input) @idempotent(key: $key) { inventoryAdjustmentGroup { id } userErrors { field message } } }`,
    { key: crypto.randomUUID(), input: { name: "available", reason: "correction", referenceDocumentUri: "magazyn://ruch-w-aplikacji", changes: items.map((i) => ({ inventoryItemId: i.item, locationId: i.location, delta: i.delta, changeFromQuantity: null })) } },
  ).then((d) => { const err = d.inventoryAdjustQuantities.userErrors.map((e) => e.message).join("; "); if (err) throw new Error(`Shopify: ${err}`); });

  // Sklepy równolegle; w sklepie jedna zmiana zbiorcza, a przy błędzie – każda pozycja osobno (błąd jednej nie blokuje reszty).
  await Promise.all([...perStore.values()].map(async ({ store, items }) => {
    const all = [...items.values()];
    const zero = all.filter((i) => i.delta === 0);
    for (const i of zero) for (const c of i.src) results.push({ ...c, ok: true, message: "bez zmiany w Shopify (ta sama lokalizacja Shopify)" });
    const live = all.filter((i) => i.delta !== 0);
    if (!live.length) return;
    const done = (i: Item, ok: boolean, message: string) => { for (const c of i.src) results.push({ ...c, ok, message }); };
    // Odmowa Shopify, bo rozmiar nie jest aktywny w tej lokalizacji (np. pierwszy towar w nowym sklepie) – aktywacja od razu ze stanem.
    const failOrActivate = async (i: Item, e: unknown) => {
      const msg = errorMessage(e);
      if (i.delta > 0 && /^Shopify:/.test(msg) && /not stocked|isn't stocked|not active|inactive/i.test(msg)) {
        const { activateAtLocation } = await import("@/lib/sync/shopify-stock");
        const r = await activateAtLocation(store.shopify_domain!, store.code, [{ inventoryItemId: i.item, locationId: i.location, quantity: i.delta }]);
        if (r.done) return done(i, true, `Shopify: aktywowano w lokalizacji, +${i.delta}`);
      }
      done(i, false, msg);
    };
    for (let n = 0; n < live.length; n += 100) {
      const part = live.slice(n, n + 100);
      try {
        await send(store, part);
        for (const i of part) done(i, true, `Shopify ${i.delta > 0 ? "+" : ""}${i.delta}`);
      } catch (e) {
        // Odmowa Shopify (userErrors) = nic nie zapisane → ponawiamy pozycje osobno. Inny błąd (np. sieć) – nie wiadomo,
        // czy zapisało; bez ponawiania (ryzyko podwójnej zmiany), pozycje zostają do ręcznego „Ponów”.
        if (!/^Shopify:/.test(errorMessage(e))) { for (const i of part) done(i, false, errorMessage(e)); continue; }
        if (part.length === 1) { await failOrActivate(part[0], e); continue; }
        for (const i of part) {
          try {
            await send(store, [i]);
            done(i, true, `Shopify ${i.delta > 0 ? "+" : ""}${i.delta}`);
          } catch (e2) {
            await failOrActivate(i, e2);
          }
        }
      }
    }
  }));
  // Sklepy-kopie (np. Owca Store) mają te same sztuki – od razu ten sam stan (przy błędzie nadrobi automat).
  const { hasMirrorStores, pushVariantsNow } = await import("@/lib/sync/shopify-stock");
  if (await hasMirrorStores(db).catch(() => false)) await pushVariantsNow(db, variantIds, { mirrorsOnly: true }).catch(() => null);
  return results;
}
