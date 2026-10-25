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
  /** Sklep-kopia (SQL 78): produkty tworzy aplikacja z tego sklepu źródłowego – katalog kopii się nie importuje. */
  mirror_of?: string | null;
};

/** Zapytanie .in() w paczkach, żeby adres zapytania nie był za długi. */
export async function selectIn<T>(
  values: string[],
  query: (chunk: string[]) => PromiseLike<{ data: unknown; error: unknown }>,
  size = 100,
) {
  // Każda porcja czytana stronami po 1000 wierszy (limit odpowiedzi Supabase) – inaczej przy produktach z wieloma
  // rozmiarami część istniejących rozmiarów „znikała” i import próbował dodać je drugi raz (duplicate key).
  const out: T[] = [];
  for (let i = 0; i < values.length; i += size) {
    const chunk = values.slice(i, i + size);
    for (let from = 0; ; from += 1000) {
      const builder = query(chunk) as PromiseLike<{ data: unknown; error: unknown }> & { range?: (a: number, b: number) => PromiseLike<{ data: unknown; error: unknown }> };
      const { data, error } = await (builder.range ? builder.range(from, from + 999) : builder);
      if (error) throw error;
      const rows = (data as T[]) ?? [];
      out.push(...rows);
      if (!builder.range || rows.length < 1000) break;
    }
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
  // Kopia (np. Owca Store): jej produkty tworzy aplikacja – import z jej Shopify zrobiłby z nich osobne produkty.
  if (store.mirror_of) return { products: 0, variants: 0, created: 0 };
  const exclusions = await loadExclusions(db);
  // Pomijamy wykluczenia z Ustawień oraz produkty, w których żaden rozmiar nie ma śledzenia stanu (usługi).
  // Działa na pojedyncze rozmiary: np. „Wymiana ekranu” + wariant „iPhone 17 (oryginał)”.
  const products = allProducts
    .map((p) => ({
      ...p,
      variants: {
        nodes: p.variants.nodes.filter(
          (v) => v.inventoryItem?.tracked !== false && !isExcluded(exclusions, [v.sku], `${p.title} ${v.title}`),
        ),
      },
    }))
    .filter((p) => p.variants.nodes.length > 0);
  if (!products.length) {
    const untrackedOnly = allProducts.flatMap((p) => p.variants.nodes.filter((v) => v.inventoryItem?.tracked === false).map((v) => v.id));
    for (let i = 0; i < untrackedOnly.length; i += 100) {
      const { error } = await db.from("variant_store_links").delete()
        .eq("store_id", store.id).in("shopify_variant_id", untrackedOnly.slice(i, i + 100));
      if (error) throw error;
    }
    return { products: 0, variants: 0, created: 0 };
  }
  const gids = products.map((p) => p.id);

  const { data: existingLinks, error: e1 } = await db
    .from("product_store_links").select("product_id, shopify_product_id")
    .eq("store_id", store.id).in("shopify_product_id", gids);
  if (e1) throw e1;
  const productIdByGid = new Map(existingLinks!.map((l) => [l.shopify_product_id as string, l.product_id as string]));

  // Produkty z tym samym SKU modelu dodane wcześniej z DRUGIEGO sklepu (ten sam model w dwóch sklepach).
  // W jednym sklepie osobne produkty Shopify z tym samym SKU (np. każda używana para osobno) to osobne rzeczy –
  // nie łączymy ich, bo stan liczyłby się raz zamiast osobno dla każdej.
  const skusToFind = products.filter((p) => !productIdByGid.has(p.id)).map(styleSku).filter((s): s is string => !!s);
  const productIdBySku = new Map<string, string>();
  if (skusToFind.length) {
    const { data, error } = await db.from("products").select("id, style_sku").in("style_sku", skusToFind);
    if (error) throw error;
    const ids = data!.map((r) => r.id as string);
    const { data: taken } = ids.length ? await db.from("product_store_links").select("product_id").eq("store_id", store.id).in("product_id", ids) : { data: [] };
    const takenHere = new Set((taken ?? []).map((t) => t.product_id as string));
    for (const r of data!) if (!takenHere.has(r.id as string)) productIdBySku.set(r.style_sku as string, r.id as string);
  }

  let created = 0;
  const rows = products.map((p) => {
    const sku = styleSku(p);
    const id = productIdByGid.get(p.id) ?? (sku ? productIdBySku.get(sku) : undefined) ?? crypto.randomUUID();
    if (!productIdByGid.has(p.id) && !(sku && productIdBySku.has(sku))) created++;
    // Dopasowanie po SKU z innego sklepu wykorzystane – kolejny produkt z tym SKU w tym sklepie dostaje własny.
    if (sku && productIdBySku.get(sku) === id) productIdBySku.delete(sku);
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

  const plRows = products.map((p) => ({
    product_id: productIdByGid.get(p.id)!,
    store_id: store.id,
    shopify_product_id: p.id,
    handle: p.handle,
    status: p.status,
    ...(p.tags ? { tags: p.tags } : {}),
    updated_at: new Date().toISOString(),
  }));
  let { error: e3 } = await db.from("product_store_links").upsert(plRows, { onConflict: "store_id,shopify_product_id" });
  // Baza bez migracji 0032 (brak kolumny tagów) – zapis bez tagów.
  if (e3 && /tags/.test(e3.message)) ({ error: e3 } = await db.from("product_store_links").upsert(plRows.map(({ tags: _t, ...r }) => r), { onConflict: "store_id,shopify_product_id" }));
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
      price: v.price !== null && v.price !== undefined && v.price !== "" ? Number(v.price) : null,
      compare_at_price: v.compareAtPrice ? Number(v.compareAtPrice) : null,
      sku: v.sku || null,
      updated_at: new Date().toISOString(),
  }));
  for (let i = 0; i < linkRows.length; i += 500) {
    let { error } = await db.from("variant_store_links").upsert(linkRows.slice(i, i + 500), { onConflict: "store_id,shopify_variant_id" });
    // Baza bez migracji 0030 (brak kolumny ceny przed obniżką) – zapis bez niej, żeby katalog działał dalej.
    if (error && /compare_at_price/.test(error.message)) {
      ({ error } = await db.from("variant_store_links").upsert(linkRows.slice(i, i + 500).map(({ compare_at_price: _c, ...r }) => r), { onConflict: "store_id,shopify_variant_id" }));
    }
    if (error) throw error;
  }

  // Rozmiary bez śledzenia stanu w Shopify („sprzedawaj zawsze”, np. sznurówki): nie są towarem na sztuki →
  // powiązanie ze Shopify jest usuwane, sztuki bez historii usuwa purge_non_shopify, reszta dostaje „brak w Shopify”.
  const untracked = allProducts.flatMap((p) => p.variants.nodes.filter((v) => v.inventoryItem?.tracked === false).map((v) => v.id));
  for (let i = 0; i < untracked.length; i += 100) {
    const { error } = await db.from("variant_store_links").delete()
      .eq("store_id", store.id).in("shopify_variant_id", untracked.slice(i, i + 100));
    if (error) throw error;
  }

  // Rozmiary usunięte z produktu w Shopify: powiązanie ze Shopify (z SKU z Base) jest usuwane → „brak w Shopify”.
  const liveGids = new Set(allProducts.flatMap((p) => p.variants.nodes.map((v) => v.id)));
  const complete = new Set(allProducts.filter((p) => p.variants.nodes.length < 250).map((p) => productIdByGid.get(p.id)).filter(Boolean));
  const checkVariants = existingVariants.filter((v) => complete.has(v.product_id)).map((v) => v.id);
  const stale = await selectIn<{ variant_id: string; shopify_variant_id: string }>(checkVariants, (chunk) =>
    db.from("variant_store_links").select("variant_id, shopify_variant_id").eq("store_id", store.id).in("variant_id", chunk).not("shopify_variant_id", "is", null));
  const gone = stale.filter((l) => !liveGids.has(l.shopify_variant_id)).map((l) => l.shopify_variant_id);
  for (let i = 0; i < gone.length; i += 100) {
    const { error } = await db.from("variant_store_links").delete()
      .eq("store_id", store.id).in("shopify_variant_id", gone.slice(i, i + 100));
    if (error) throw error;
  }

  // Sklepy-kopie tego sklepu: zmienione / nowe produkty do utworzenia albo aktualizacji w kopii.
  const { enqueueMirror } = await import("./mirror");
  await enqueueMirror(db, store.id, [...new Set(products.map((p) => productIdByGid.get(p.id)!))]).catch(() => 0);

  return { products: products.length, variants: allVariants.length, created };
}

const PAGE_QUERY = `query($after: String) {
  products(first: 100, after: $after) {
    nodes {
      id title handle vendor productType status tags
      featuredMedia { preview { image { url } } }
      variants(first: 100) { nodes { id title sku barcode position price compareAtPrice inventoryItem { id tracked } } }
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
  // Usunięty w sklepie źródłowym → w kopiach archiwum (przy błędzie – do kolejki, automat ponowi).
  if (!store.mirror_of) {
    const { mirrorPairs, archiveInMirror, enqueueMirror } = await import("./mirror");
    for (const pair of (await mirrorPairs(db)).filter((p) => p.source.id === store.id)) {
      await archiveInMirror(db, pair.mirror, link.product_id as string).catch(() => enqueueMirror(db, store.id, [link.product_id as string]));
    }
  }
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

/**
 * Produkty usunięte w Shopify (bez webhooka – np. przed włączeniem „na żywo”): sprawdza, które produkty
 * z katalogu jeszcze istnieją, a przy usuniętych usuwa powiązania ze Shopify (tak jak webhook products/delete).
 */
export async function detachDeletedShopifyProducts(db: SupabaseClient) {
  const { data: stores } = await db.from("stores").select("*").not("shopify_domain", "is", null);
  const out: Record<string, number> = {};
  for (const store of (stores ?? []) as Store[]) {
    // Kopia: brakujące produkty odtwarza automat kopii.
    if (store.mirror_of) continue;
    const gids: string[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db.from("product_store_links").select("shopify_product_id").eq("store_id", store.id).not("shopify_product_id", "is", null).range(from, from + 999);
      if (error) throw error;
      gids.push(...(data ?? []).map((r) => r.shopify_product_id as string));
      if ((data ?? []).length < 1000) break;
    }
    const missing: string[] = [];
    for (let i = 0; i < gids.length; i += 250) {
      const part = gids.slice(i, i + 250);
      const data = await shopifyGraphql<{ nodes: ({ id: string } | null)[] }>(store.shopify_domain!, store.code, `query($ids: [ID!]!) { nodes(ids: $ids) { id } }`, { ids: part });
      data.nodes.forEach((n, j) => { if (!n) missing.push(part[j]); });
    }
    for (let i = 0; i < missing.length; i += 100) {
      const chunk = missing.slice(i, i + 100);
      const { data: links } = await db.from("product_store_links").select("product_id").eq("store_id", store.id).in("shopify_product_id", chunk);
      const productIds = (links ?? []).map((l) => l.product_id as string);
      // Kopie tego sklepu: produkty usunięte w źródle → do kolejki (automat kopii przeniesie je do archiwum).
      if (productIds.length) await (await import("./mirror")).enqueueMirror(db, store.id, productIds).catch(() => 0);
      if (productIds.length) {
        const variants = await selectIn<{ id: string }>(productIds, (c) => db.from("variants").select("id").in("product_id", c));
        const ids = variants.map((v) => v.id);
        for (let k = 0; k < ids.length; k += 200) {
          const { error } = await db.from("variant_store_links").delete()
            .eq("store_id", store.id).in("variant_id", ids.slice(k, k + 200));
          if (error) throw error;
        }
      }
      const { error } = await db.from("product_store_links").delete().eq("store_id", store.id).in("shopify_product_id", chunk);
      if (error) throw error;
    }
    out[store.name] = missing.length;
  }
  return out;
}

/**
 * Rozdzielenie produktów Shopify z tym samym SKU, które w jednym sklepie zostały połączone w jeden produkt aplikacji:
 * pierwszy zostaje, pozostałe dostają własny produkt i rozmiary (stan każdego liczy się osobno przy kolejnym odczycie stanów).
 */
export async function splitSameStoreDuplicates(db: SupabaseClient, limit = 20) {
  const { data, error } = await db.rpc("duplicate_store_products", { p_limit: limit });
  if (error) {
    if (/duplicate_store_products/.test(error.message)) return { split: 0, skipped: "brak migracji 0033" };
    throw error;
  }
  const groups = (data ?? []) as { store_id: string; product_id: string; shopify_product_ids: string[] }[];
  if (!groups.length) return { split: 0 };
  const { data: stores } = await db.from("stores").select("*").in("id", [...new Set(groups.map((g) => g.store_id))]);
  let split = 0;
  for (const g of groups) {
    const store = (stores ?? []).find((s) => s.id === g.store_id) as Store | undefined;
    if (!store?.shopify_domain) continue;
    split += await splitProductGids(db, store, g.shopify_product_ids);
  }
  return { split };
}

/** Pierwszy produkt Shopify zostaje przy produkcie aplikacji, pozostałe (ten sam SKU, ten sam sklep) dostają własne. */
export async function splitProductGids(db: SupabaseClient, store: Store, gids: string[]) {
  let split = 0;
  for (const gid of gids.slice(1)) {
    const product = await getProduct(store.shopify_domain!, store.code, gid).catch(() => null);
    if (!product) continue;
    const variantGids = product.variants.nodes.map((v) => v.id);
    for (let i = 0; i < variantGids.length; i += 100) {
      await db.from("variant_store_links").delete().eq("store_id", store.id).in("shopify_variant_id", variantGids.slice(i, i + 100));
    }
    await db.from("product_store_links").delete().eq("store_id", store.id).eq("shopify_product_id", gid);
    await upsertShopifyProducts(db, store, [product]);
    split++;
  }
  return split;
}
