import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getStock, setStock } from "@/lib/integrations/base";
import { shopifyGraphql } from "@/lib/integrations/shopify";
import { errorMessage } from "@/lib/errors";

export type StockChange = { variantId: string; locationId: string; delta: number };

/**
 * Zmiana stanu po ruchu w aplikacji (kasa, faktura, dostawa, zwrot, przesunięcie, usunięcie):
 * najpierw Shopify (główny – zmiana o deltę w lokalizacji Shopify przypisanej do lokalizacji aplikacji),
 * potem – jeśli rozmiar jest powiązany – Base (pomocniczo; błąd Base nie jest błędem zmiany).
 * Wynik ok = Shopify zaktualizowany; zmiany z błędem można ponowić bez ryzyka podwójnej zmiany.
 */
export async function adjustStock(db: SupabaseClient, changes: StockChange[]) {
  const merged = new Map<string, StockChange>();
  for (const c of changes) {
    const k = `${c.variantId}|${c.locationId}`;
    const prev = merged.get(k);
    merged.set(k, { ...c, delta: (prev?.delta ?? 0) + c.delta });
  }
  const results: (StockChange & { ok: boolean; message: string })[] = [];
  for (const c of merged.values()) {
    if (c.delta === 0) continue;
    try {
      const { data: loc } = await db.from("locations").select("name, shopify_location_id, store:stores(id, name, code, shopify_domain)").eq("id", c.locationId).single();
      if (!loc) throw new Error("nie znaleziono lokalizacji");
      const store = loc.store as unknown as { id: string; name: string; code: string; shopify_domain: string | null };
      if (!store.shopify_domain) throw new Error(`sklep ${store.name} nie ma domeny Shopify`);
      if (!loc.shopify_location_id) throw new Error(`lokalizacja „${loc.name}” nie ma przypisanej lokalizacji Shopify (Ustawienia → Stany magazynowe)`);
      const { data: link } = await db.from("variant_store_links").select("shopify_inventory_item_id")
        .eq("variant_id", c.variantId).eq("store_id", store.id).not("shopify_inventory_item_id", "is", null).limit(1).maybeSingle();
      if (!link) throw new Error(`ten rozmiar nie ma wariantu w Shopify ${store.name}`);
      const data = await shopifyGraphql<{ inventoryAdjustQuantities: { userErrors: { message: string }[] } }>(
        store.shopify_domain, store.code,
        `mutation Adj($input: InventoryAdjustQuantitiesInput!, $key: String!) { inventoryAdjustQuantities(input: $input) @idempotent(key: $key) { inventoryAdjustmentGroup { id } userErrors { field message } } }`,
        { key: crypto.randomUUID(), input: { name: "available", reason: "correction", referenceDocumentUri: "magazyn://ruch-w-aplikacji", changes: [{ inventoryItemId: link.shopify_inventory_item_id, locationId: loc.shopify_location_id, delta: c.delta, changeFromQuantity: null }] } },
      );
      const err = data.inventoryAdjustQuantities.userErrors.map((e) => e.message).join("; ");
      if (err) throw new Error(`Shopify: ${err}`);
      let base = "";
      if (process.env.BASE_API_TOKEN) {
        const [b] = await adjustBaseStock(db, [c]);
        base = b?.ok ? ` · ${b.message}` : b && !/nie jest powiązany|nie ma przypisanego/.test(b.message) ? ` · Base: ${b.message}` : "";
      }
      results.push({ ...c, ok: true, message: `Shopify ${c.delta > 0 ? "+" : ""}${c.delta}${base}` });
    } catch (e) {
      results.push({ ...c, ok: false, message: errorMessage(e) });
    }
  }
  return results;
}

/**
 * Zmienia stan w Base o podaną liczbę sztuk (odczyt aktualnego stanu + zapis nowego),
 * tak jak dziś ręczne „0 → 1”. Teraz pomocniczo – główny jest Shopify (adjustStock).
 */
export async function adjustBaseStock(db: SupabaseClient, changes: StockChange[]) {
  const merged = new Map<string, StockChange>();
  for (const c of changes) {
    const k = `${c.variantId}|${c.locationId}`;
    const prev = merged.get(k);
    merged.set(k, { ...c, delta: (prev?.delta ?? 0) + c.delta });
  }

  const results: (StockChange & { ok: boolean; message: string })[] = [];
  for (const c of merged.values()) {
    if (c.delta === 0) continue;
    try {
      const { data: loc, error: le } = await db
        .from("locations").select("name, base_warehouse_id, store:stores(id, name, base_inventory_id)")
        .eq("id", c.locationId).single();
      if (le || !loc) throw new Error("nie znaleziono lokalizacji");
      const store = loc.store as unknown as { id: string; name: string; base_inventory_id: number | null };
      if (!loc.base_warehouse_id) throw new Error(`lokalizacja „${loc.name}” nie ma przypisanego magazynu Base`);
      if (!store.base_inventory_id) throw new Error(`sklep ${store.name} nie ma przypisanego katalogu Base`);

      const { data: link } = await db
        .from("variant_store_links").select("base_product_id, base_parent_id, base_link_source")
        .eq("variant_id", c.variantId).eq("store_id", store.id).not("base_product_id", "is", null)
        .in("base_link_source", ["base", "manual"]).limit(1).maybeSingle();
      if (!link) throw new Error(`ten rozmiar nie jest powiązany z produktem w Base dla sklepu ${store.name} (Katalog → bez powiązania)`);

      const current = await getStock(store.base_inventory_id, link.base_product_id, link.base_parent_id, loc.base_warehouse_id);
      const next = Math.max(0, current + c.delta);
      await setStock(store.base_inventory_id, { [String(link.base_product_id)]: { [loc.base_warehouse_id]: next } });
      results.push({ ...c, ok: true, message: `Base: ${current} → ${next}` });
    } catch (e) {
      results.push({ ...c, ok: false, message: errorMessage(e) });
    }
  }
  return results;
}
