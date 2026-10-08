import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getProduct, shopifyGraphql, type ShopifyProduct } from "@/lib/integrations/shopify";
import { isExcluded, loadExclusions } from "@/lib/services";

export type Store = {
  id: string;
  code: string;
  name: string;
  shopify_domain: string | null;
  base_inventory_id: number | null;
  base_order_source_id: number | null;
  base_storage_id: string | null;
};

/** Zapytanie .in() w paczkach, żeby adres zapytania nie był za długi. */
export async function selectIn<T>(
  values: string[],
  query: (chunk: string[]) => PromiseLike<{ data: unknown; error: unknown }>,
  size = 100,
) {
  const out: T[] = [];
  for (let i = 0; i < values.length; i += size) {
    const { data, error } = await query(values.slice(i, i + size));
    if (error) throw error;
    out.push(...((data as T[]) ?? []));
  }
  return out;
}

const DEFAULT_OPTION = "jeden rozmiar";

function optionOf(v: ShopifyProduct["variants"]["nodes"][number]) {
  return !v.title || v.title === "Default Title" ? DEFAULT_OPTION : v.title.trim();
}

/** SKU modelu: najczęstsze SKU wśród wariantów (w Shopify zwykle jedno dla wszystkich rozmiarów). */
function styleSku(p: ShopifyProduct) {
  const counts = new Map<string, number>();
  for (const v of p.variants.nodes) {
    const s = v.sku?.trim();
    if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/**
 * Zapis paczki produktów Shopify jednego sklepu. Ten sam model w obu sklepach łączy się
 * w jeden produkt po SKU modelu, a warianty po rozmiarze.
 */
export async function upsertShopifyProducts(db: SupabaseClient, store: Store, allProducts: ShopifyProduct[]) {
  const exclusions = await loadExclusions(db);
  // Pomijamy wykluczenia z Ustawień oraz produkty, w których żaden rozmiar nie ma śledzenia stanu (usługi).
  const products = allProducts.filter(
    (p) =>
      !isExcluded(exclusions, p.variants.nodes.map((v) => v.sku), p.title) &&
      p.variants.nodes.some((v) => v.inventoryItem?.tracked !== false),
  );
  if (!products.length) return { products: 0, variants: 0, created: 0 };
  const gids = products.map((p) => p.id);

  const { data: existingLinks, error: e1 } = await db
    .from("product_store_links").select("product_id, shopify_product_id")
    .eq("store_id", store.id).in("shopify_product_id", gids);
  if (e1) throw e1;
  const productIdByGid = new Map(existingLinks!.map((l) => [l.shopify_product_id as string, l.product_id as string]));

  // Produkty z tym samym SKU modelu dodane wcześniej z drugiego sklepu.
  const skusToFind = products.filter((p) => !productIdByGid.has(p.id)).map(styleSku).filter((s): s is string => !!s);
  const productIdBySku = new Map<string, string>();
  if (skusToFind.length) {
    const { data, error } = await db.from("products").select("id, style_sku").in("style_sku", skusToFind);
    if (error) throw error;
    for (const r of data!) productIdBySku.set(r.style_sku as string, r.id as string);
  }

  let created = 0;
  const rows = products.map((p) => {
    const sku = styleSku(p);
    const id = productIdByGid.get(p.id) ?? (sku ? productIdBySku.get(sku) : undefined) ?? crypto.randomUUID();
    if (!productIdByGid.has(p.id) && !(sku && productIdBySku.has(sku))) created++;
    if (sku && !productIdBySku.has(sku)) productIdBySku.set(sku, id); // duplikaty w jednej paczce
    productIdByGid.set(p.id, id);
    return {
      id,
      title: p.title,
      style_sku: sku,
      vendor: p.vendor,
      product_type: p.productType,
      image_url: p.featuredMedia?.preview?.image?.url ?? null,
    };
  });
  const uniqueRows = [...new Map(rows.map((r) => [r.id, r])).values()];
  const { error: e2 } = await db.from("products").upsert(uniqueRows, { onConflict: "id" });
  if (e2) throw e2;

  const { error: e3 } = await db.from("product_store_links").upsert(
    products.map((p) => ({
      product_id: productIdByGid.get(p.id)!,
      store_id: store.id,
      shopify_product_id: p.id,
      handle: p.handle,
      status: p.status,
      updated_at: new Date().toISOString(),
    })),
    { onConflict: "store_id,shopify_product_id" },
  );
  if (e3) throw e3;

  // Warianty
  const allVariants = products.flatMap((p) => p.variants.nodes.map((v) => ({ p, v, productId: productIdByGid.get(p.id)! })));
  const variantGids = allVariants.map((x) => x.v.id);
  const productIds = [...new Set(allVariants.map((x) => x.productId))];

  const vLinks = await selectIn<{ variant_id: string; shopify_variant_id: string }>(
    variantGids,
    (chunk) => db.from("variant_store_links").select("variant_id, shopify_variant_id").eq("store_id", store.id).in("shopify_variant_id", chunk),
  );
  const existingVariants = await selectIn<{ id: string; product_id: string; option: string }>(
    productIds,
    (chunk) => db.from("variants").select("id, product_id, option").in("product_id", chunk),
  );
  const variantIdByGid = new Map(vLinks.map((l) => [l.shopify_variant_id, l.variant_id]));
  const variantIdByKey = new Map(existingVariants.map((v) => [`${v.product_id}|${v.option.toLowerCase()}`, v.id]));

  const newVariants: { id: string; product_id: string; option: string; ean: string | null; position: number }[] = [];
  for (const { v, productId } of allVariants) {
    if (variantIdByGid.has(v.id)) continue;
    const key = `${productId}|${optionOf(v).toLowerCase()}`;
    let id = variantIdByKey.get(key);
    if (!id) {
      id = crypto.randomUUID();
      variantIdByKey.set(key, id);
      newVariants.push({ id, product_id: productId, option: optionOf(v), ean: v.barcode || null, position: v.position });
    }
    variantIdByGid.set(v.id, id);
  }
  for (let i = 0; i < newVariants.length; i += 500) {
    const { error } = await db.from("variants").insert(newVariants.slice(i, i + 500));
    if (error) throw error;
  }

  const linkRows = allVariants.map(({ v }) => ({
      variant_id: variantIdByGid.get(v.id)!,
      store_id: store.id,
      shopify_variant_id: v.id,
      shopify_inventory_item_id: v.inventoryItem?.id ?? null,
      inventory_tracked: v.inventoryItem?.tracked !== false,
      sku: v.sku || null,
      updated_at: new Date().toISOString(),
  }));
  for (let i = 0; i < linkRows.length; i += 500) {
    const { error } = await db.from("variant_store_links").upsert(linkRows.slice(i, i + 500), { onConflict: "store_id,shopify_variant_id" });
    if (error) throw error;
  }

  return { products: products.length, variants: allVariants.length, created };
}

const PAGE_QUERY = `query($after: String) {
  products(first: 100, after: $after) {
    nodes {
      id title handle vendor productType status
      featuredMedia { preview { image { url } } }
      variants(first: 100) { nodes { id title sku barcode position inventoryItem { id tracked } } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

/** Jedna strona importu katalogu (100 produktów). Zwraca kursor następnej strony. */
export async function importCatalogPage(db: SupabaseClient, store: Store, after: string | null) {
  if (!store.shopify_domain) throw new Error(`Sklep ${store.name} nie ma ustawionej domeny Shopify`);
  const data = await shopifyGraphql<{
    products: { nodes: ShopifyProduct[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
  }>(store.shopify_domain, store.code, PAGE_QUERY, { after });
  // Produkty z ponad 100 wariantami doczytujemy w całości.
  const nodes = await Promise.all(
    data.products.nodes.map(async (p) =>
      p.variants.nodes.length >= 100 ? ((await getProduct(store.shopify_domain!, store.code, p.id)) ?? p) : p,
    ),
  );
  const result = await upsertShopifyProducts(db, store, nodes);
  return { ...result, next: data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null };
}

/** Produkt usunięty w Shopify (webhook products/delete). */
export async function removeShopifyProduct(db: SupabaseClient, store: Store, productGid: string) {
  const { data: link } = await db.from("product_store_links").select("product_id").eq("store_id", store.id).eq("shopify_product_id", productGid).maybeSingle();
  if (!link) return;
  const { data: variants } = await db.from("variants").select("id").eq("product_id", link.product_id);
  const ids = (variants ?? []).map((v) => v.id as string);
  if (ids.length) await db.from("variant_store_links").delete().eq("store_id", store.id).in("variant_id", ids);
  await db.from("product_store_links").delete().eq("store_id", store.id).eq("shopify_product_id", productGid);
  // Produkt bez sklepów i bez sztuk znika całkowicie (prune robi to dla wszystkich takich produktów).
  await db.rpc("prune_store_catalog", { p_store_id: store.id, p_started_at: "1970-01-01T00:00:00Z" });
}

/** Produkt z webhooka products/create lub products/update. */
export async function syncSingleProduct(db: SupabaseClient, store: Store, productGid: string) {
  const product = await getProduct(store.shopify_domain!, store.code, productGid);
  if (!product) return { products: 0, variants: 0, created: 0 };
  return upsertShopifyProducts(db, store, [product]);
}
