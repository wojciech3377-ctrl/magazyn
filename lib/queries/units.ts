import type { SupabaseClient } from "@supabase/supabase-js";

export type UnitFilters = {
  q?: string;
  sklep?: string;
  lokalizacja?: string;
  status?: string;
  umowa?: string; // "brak" | "jest"
  wlasciciel?: string; // own | consignment
  komisant?: string;
  forma?: string; // vat_margin | vat_23
  rozmiar?: string;
  cena_od?: string;
  cena_do?: string;
  zakup_od?: string;
  zakup_do?: string;
  od?: string; // data przyjęcia od (YYYY-MM-DD)
  do?: string;
  imei?: string; // "jest" | "brak"
  sort?: string;
  kier?: string; // asc | desc
};

/** Kolumny, po których można sortować listę sztuk (widok units_list). */
export const UNIT_SORTS: Record<string, { column: string; label: string; asc: boolean }> = {
  przyjeta: { column: "received_at", label: "Data przyjęcia", asc: false },
  nazwa: { column: "title", label: "Nazwa", asc: true },
  rozmiar: { column: "option", label: "Rozmiar", asc: true },
  kod: { column: "number", label: "Kod sztuki", asc: false },
  cena: { column: "shop_price", label: "Cena w sklepie", asc: false },
  zakup: { column: "purchase_price", label: "Cena zakupu", asc: false },
  lokalizacja: { column: "location_name", label: "Lokalizacja", asc: true },
  status: { column: "status", label: "Status", asc: true },
  komisant: { column: "consignor_name", label: "Komisant", asc: true },
  sprzedana: { column: "sold_at", label: "Data sprzedaży", asc: false },
};

export const UNIT_SELECT = `
  id, code, status, owner_type, purchase_form, purchase_price, payout_amount, identifier, shelf, received_at, sold_at, contract_id, notes,
  consignor:consignors(id, name),
  contract:contracts(id, type, counterparty),
  location:locations!inner(id, name, store_id, store:stores(id, name)),
  variant:variants!inner(id, option, links:variant_store_links(store_id, base_sku, price), product:products!inner(id, title, style_sku, image_url))
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
  variant: { id: string; option: string; links: { store_id: string; base_sku: string | null; price: number | null }[]; product: { id: string; title: string; style_sku: string | null; image_url: string | null } };
};

type ListRow = {
  id: string; code: string; status: string; owner_type: string; purchase_form: string; purchase_price: number | null; payout_amount: number | null;
  identifier: string | null; shelf: string | null; received_at: string; sold_at: string | null; contract_id: string | null; notes: string | null;
  variant_id: string; option: string; product_id: string; title: string; style_sku: string | null; image_url: string | null;
  location_id: string; location_name: string; store_id: string; store_name: string; consignor_id: string | null; consignor_name: string | null;
  contract_type: string | null; contract_counterparty: string | null; shop_price: number | null; base_sku: string | null;
};

const num = (v: string | undefined) => (v && v.trim() !== "" && Number.isFinite(Number(v.replace(",", "."))) ? Number(v.replace(",", ".")) : null);
const day = (v: string | undefined) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

/** Lista sztuk z filtrami i sortowaniem (ekran Magazyn i eksport CSV) – z widoku units_list. */
export async function queryUnits(db: SupabaseClient, f: UnitFilters, range?: [number, number]) {
  let query = db.from("units_list").select("*", { count: "exact" });

  if (f.status === "wszystkie") {
    // bez filtra
  } else if (f.status) {
    query = query.eq("status", f.status);
  } else {
    query = query.in("status", ["in_stock", "in_transit", "reserved"]);
  }
  if (f.sklep) query = query.eq("store_id", f.sklep);
  if (f.lokalizacja) query = query.eq("location_id", f.lokalizacja);
  if (f.umowa === "brak") query = query.is("contract_id", null);
  if (f.umowa === "jest") query = query.not("contract_id", "is", null);
  if (f.wlasciciel) query = query.eq("owner_type", f.wlasciciel);
  if (f.komisant) query = query.eq("consignor_id", f.komisant);
  if (f.forma) query = query.eq("purchase_form", f.forma);
  if (f.rozmiar?.trim()) query = query.ilike("option", `${f.rozmiar.trim().replace(/[%,()*\\]/g, "")}%`);
  if (f.imei === "jest") query = query.not("identifier", "is", null);
  if (f.imei === "brak") query = query.is("identifier", null);
  const [cOd, cDo, zOd, zDo] = [num(f.cena_od), num(f.cena_do), num(f.zakup_od), num(f.zakup_do)];
  if (cOd !== null) query = query.gte("shop_price", cOd);
  if (cDo !== null) query = query.lte("shop_price", cDo);
  if (zOd !== null) query = query.gte("purchase_price", zOd);
  if (zDo !== null) query = query.lte("purchase_price", zDo);
  if (day(f.od)) query = query.gte("received_at", `${f.od}T00:00:00+02:00`);
  if (day(f.do)) query = query.lte("received_at", `${f.do}T23:59:59+02:00`);

  const q = f.q?.trim();
  if (q) {
    const safe = q.replace(/[,()*%\\]/g, " ").trim();
    const variantIds = await findVariantIds(db, safe);
    const ors = [`code.ilike.%${safe}%`, `identifier.ilike.%${safe}%`, `title.ilike.%${safe}%`, `style_sku.ilike.%${safe}%`, `base_sku.ilike.%${safe}%`];
    if (variantIds.length) ors.push(`variant_id.in.(${variantIds.slice(0, 150).join(",")})`);
    query = query.or(ors.join(","));
  }

  const sort = UNIT_SORTS[f.sort ?? ""] ?? UNIT_SORTS.przyjeta;
  const asc = f.kier === "asc" ? true : f.kier === "desc" ? false : sort.asc;
  query = query.order(sort.column, { ascending: asc, nullsFirst: false }).order("number", { ascending: false });
  if (range) query = query.range(range[0], range[1]);
  const { data, count, error } = await query;
  if (error) throw error;
  const rows = ((data ?? []) as ListRow[]).map((r): UnitRow => ({
    id: r.id, code: r.code, status: r.status, owner_type: r.owner_type, purchase_form: r.purchase_form, purchase_price: r.purchase_price,
    payout_amount: r.payout_amount, identifier: r.identifier, shelf: r.shelf, received_at: r.received_at, sold_at: r.sold_at,
    contract_id: r.contract_id, notes: r.notes,
    consignor: r.consignor_id ? { id: r.consignor_id, name: r.consignor_name ?? "" } : null,
    contract: r.contract_id ? { id: r.contract_id, type: r.contract_type ?? "", counterparty: r.contract_counterparty ?? "umowa" } : null,
    location: { id: r.location_id, name: r.location_name, store_id: r.store_id, store: { id: r.store_id, name: r.store_name } },
    variant: {
      id: r.variant_id, option: r.option,
      links: [{ store_id: r.store_id, base_sku: r.base_sku, price: r.shop_price }],
      product: { id: r.product_id, title: r.title, style_sku: r.style_sku, image_url: r.image_url },
    },
  }));
  return { rows, count: count ?? 0 };
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
