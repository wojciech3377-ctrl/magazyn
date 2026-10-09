import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getStock, setStock } from "@/lib/integrations/base";
import { errorMessage } from "@/lib/errors";

export type StockChange = { variantId: string; locationId: string; delta: number };

/**
 * Zmienia stan w Base o podaną liczbę sztuk (odczyt aktualnego stanu + zapis nowego),
 * tak jak dziś ręczne „0 → 1”. Base sam aktualizuje potem sklepy Shopify.
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
