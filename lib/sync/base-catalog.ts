import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getInventoryProductsData, listInventoryProductIds, type BaseProductData } from "@/lib/integrations/base";

type State = { ids: number[]; offset: number; startedAt: string };

const CHUNK = 100; // ok. 1 + (warianty / 100) zapytań na paczkę; limit Base to 100 zapytań na minutę
const stateKey = (inventoryId: number) => `base_catalog_${inventoryId}`;

export async function startBaseCatalogSync(db: SupabaseClient, inventoryId: number) {
  const ids = await listInventoryProductIds(inventoryId);
  const state: State = { ids, offset: 0, startedAt: new Date().toISOString() };
  const { error } = await db.from("sync_state").upsert({ key: stateKey(inventoryId), value: state, updated_at: new Date().toISOString() });
  if (error) throw error;
  return { total: ids.length };
}

function hasLinks(p: BaseProductData | undefined) {
  return !!p?.links && !Array.isArray(p.links) && Object.keys(p.links).length > 0;
}

/** Kolejna paczka katalogu Base → tabela base_products. */
export async function baseCatalogChunk(db: SupabaseClient, inventoryId: number) {
  const { data: row, error } = await db.from("sync_state").select("value").eq("key", stateKey(inventoryId)).single();
  if (error) throw new Error("Najpierw uruchom pobieranie katalogu Base od początku");
  const state = row.value as State;
  const ids = state.ids.slice(state.offset, state.offset + CHUNK);
  if (!ids.length) return { done: true, processed: state.offset, total: state.ids.length };

  await upsertBaseProducts(db, inventoryId, ids);
  const now = new Date().toISOString();
  state.offset += ids.length;
  await db.from("sync_state").update({ value: state, updated_at: now }).eq("key", stateKey(inventoryId));
  return { done: state.offset >= state.ids.length, processed: state.offset, total: state.ids.length };
}

/** Pobranie z Base danych produktów (z wariantami i powiązaniami ze sklepem) do tabeli base_products. */
export async function upsertBaseProducts(db: SupabaseClient, inventoryId: number, ids: number[]) {
  const data = await getInventoryProductsData(inventoryId, ids);
  const rows: Record<string, unknown>[] = [];
  const variantIds: number[] = [];
  const now = new Date().toISOString();

  for (const [id, p] of Object.entries(data)) {
    const variants = p.variants && !Array.isArray(p.variants) ? p.variants : {};
    const name = p.text_fields?.name ?? null;
    rows.push({
      inventory_id: inventoryId,
      id: Number(id),
      parent_id: 0,
      name,
      variant_name: null,
      sku: p.sku || null,
      ean: p.ean || null,
      has_variants: Object.keys(variants).length > 0,
      links: hasLinks(p) ? p.links : {},
      stock: p.stock && !Array.isArray(p.stock) ? p.stock : {},
      synced_at: now,
    });
    for (const [vid, v] of Object.entries(variants)) {
      variantIds.push(Number(vid));
      rows.push({
        inventory_id: inventoryId,
        id: Number(vid),
        parent_id: Number(id),
        name,
        variant_name: v.name ?? null,
        sku: v.sku || null,
        ean: v.ean || null,
        has_variants: false,
        links: {},
        stock: v.stock && !Array.isArray(v.stock) ? v.stock : {},
        synced_at: now,
      });
    }
  }

  // Powiązania wariantów ze sklepem: Base podaje je przy zapytaniu o ID wariantu.
  if (variantIds.length) {
    const vdata = await getInventoryProductsData(inventoryId, variantIds);
    for (const r of rows) {
      const v = vdata[String(r.id)];
      if (r.parent_id !== 0 && hasLinks(v)) r.links = v!.links;
    }
  }

  for (let i = 0; i < rows.length; i += 500) {
    const { error: e } = await db.from("base_products").upsert(rows.slice(i, i + 500), { onConflict: "inventory_id,id" });
    if (e) throw e;
  }

}
