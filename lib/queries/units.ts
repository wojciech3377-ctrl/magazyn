import type { SupabaseClient } from "@supabase/supabase-js";

export type UnitFilters = {
  q?: string;
  sklep?: string;
  lokalizacja?: string;
  status?: string;
  umowa?: string; // "brak" | "jest"
  wlasciciel?: string; // own | consignment
  komisant?: string;
};

export const UNIT_SELECT = `
  id, code, status, owner_type, purchase_form, purchase_price, payout_amount, identifier, shelf, received_at, sold_at, contract_id, notes,
  consignor:consignors(id, name),
  contract:contracts(id, type, counterparty),
  location:locations!inner(id, name, store_id, store:stores(id, name)),
  variant:variants!inner(id, option, links:variant_store_links(store_id, base_sku), product:products!inner(id, title, style_sku, image_url))
`;

export type UnitRow = {
  id: string;
  code: string;
  status: string;
  owner_type: string;
  purchase_form: string;
  purchase_price: number | null;
  payout_amount: number | null;
  identifier: string | null;
  shelf: string | null;
  received_at: string;
  sold_at: string | null;
  contract_id: string | null;
  notes: string | null;
  consignor: { id: string; name: string } | null;
  contract: { id: string; type: string; counterparty: string } | null;
  location: { id: string; name: string; store_id: string; store: { id: string; name: string } };
  variant: { id: string; option: string; links: { store_id: string; base_sku: string | null }[]; product: { id: string; title: string; style_sku: string | null; image_url: string | null } };
};

/** Lista sztuk z filtrami (ekran Magazyn i eksport CSV). */
export async function queryUnits(db: SupabaseClient, f: UnitFilters, range?: [number, number]) {
  let query = db.from("units").select(UNIT_SELECT, { count: "exact" });

  if (f.status === "wszystkie") {
    // bez filtra
  } else if (f.status) {
    query = query.eq("status", f.status);
  } else {
    query = query.in("status", ["in_stock", "in_transit", "reserved"]);
  }
  if (f.sklep) query = query.eq("location.store_id", f.sklep);
  if (f.lokalizacja) query = query.eq("location_id", f.lokalizacja);
  if (f.umowa === "brak") query = query.is("contract_id", null);
  if (f.umowa === "jest") query = query.not("contract_id", "is", null);
  if (f.wlasciciel) query = query.eq("owner_type", f.wlasciciel);
  if (f.komisant) query = query.eq("consignor_id", f.komisant);

  const q = f.q?.trim();
  if (q) {
    const safe = q.replace(/[,()*%\\]/g, " ").trim();
    const variantIds = await findVariantIds(db, safe);
    const ors = [`code.ilike.%${safe}%`, `identifier.ilike.%${safe}%`];
    if (variantIds.length) ors.push(`variant_id.in.(${variantIds.slice(0, 150).join(",")})`);
    query = query.or(ors.join(","));
  }

  query = query.order("received_at", { ascending: false }).order("number", { ascending: false });
  if (range) query = query.range(range[0], range[1]);
  const { data, count, error } = await query;
  if (error) throw error;
  return { rows: (data ?? []) as unknown as UnitRow[], count: count ?? 0 };
}

/** Warianty pasujące do tekstu: nazwa produktu, SKU modelu, SKU ze sklepu lub z Base, EAN. */
export async function findVariantIds(db: SupabaseClient, text: string) {
  const like = `%${text}%`;
  const [products, links, variants] = await Promise.all([
    db.from("products").select("id").or(`title.ilike.${like},style_sku.ilike.${like}`).limit(200),
    db.from("variant_store_links").select("variant_id").or(`sku.ilike.${like},base_sku.ilike.${like}`).limit(300),
    db.from("variants").select("id").eq("ean", text).limit(50),
  ]);
  const ids = new Set<string>();
  for (const l of links.data ?? []) ids.add(l.variant_id as string);
  for (const v of variants.data ?? []) ids.add(v.id as string);
  const productIds = (products.data ?? []).map((p) => p.id as string);
  if (productIds.length) {
    const { data } = await db.from("variants").select("id").in("product_id", productIds.slice(0, 100));
    for (const v of data ?? []) ids.add(v.id as string);
  }
  return [...ids];
}
