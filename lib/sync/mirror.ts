import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { shopifyGraphql } from "@/lib/integrations/shopify";
import { errorMessage } from "@/lib/errors";

/**
 * Sklep-kopia (SQL 78, np. Owca Store ← Sneakers Depot): produkty ze sklepu źródłowego są tworzone i aktualizowane
 * w kopii (tytuł, opis, zdjęcia, rozmiary, SKU, kody, ceny, tagi, typ, marka, SEO, status). Kopia nie ma własnych
 * produktów w aplikacji – jej produkty i rozmiary wskazują te same produkty / rozmiary co źródło (te same sztuki).
 * Kolejka mirror_queue: zmiany ze źródła (import katalogu, webhooki) i brakujące produkty (pierwsze uzupełnienie).
 */

export type MirrorStore = { id: string; code: string; name: string; shopify_domain: string; mirror_of: string; mirror_location_id: string | null };
type SourceStore = { id: string; code: string; name: string; shopify_domain: string };
export type MirrorPair = { mirror: MirrorStore; source: SourceStore };

let pairsCache: { at: number; pairs: MirrorPair[] } | null = null;

/** Sklepy-kopie z domeną Shopify i ich źródła (krótka pamięć – sprawdzane przy każdym imporcie katalogu). */
export async function mirrorPairs(db: SupabaseClient, fresh = false): Promise<MirrorPair[]> {
  if (!fresh && pairsCache && Date.now() - pairsCache.at < 60_000) return pairsCache.pairs;
  const { data, error } = await db.from("stores").select("*");
  if (error) return [];
  const stores = (data ?? []) as (MirrorStore & { mirror_of: string | null })[];
  const pairs: MirrorPair[] = [];
  for (const m of stores) {
    if (!m.mirror_of || !m.shopify_domain) continue;
    const s = stores.find((x) => x.id === m.mirror_of);
    if (s?.shopify_domain) pairs.push({ mirror: m as MirrorStore, source: s as SourceStore });
  }
  pairsCache = { at: Date.now(), pairs };
  return pairs;
}

/** Czy sklep jest kopią (jego produkty i stany prowadzi aplikacja – bez importu katalogu i stanów z jego Shopify). */
export async function isMirrorStore(db: SupabaseClient, storeId: string) {
  const { data } = await db.from("stores").select("*").eq("id", storeId).maybeSingle();
  return !!(data as { mirror_of?: string | null } | null)?.mirror_of;
}

/** Zmienione / nowe produkty sklepu źródłowego → do kolejki każdej jego kopii. */
export async function enqueueMirror(db: SupabaseClient, sourceStoreId: string, productIds: string[]) {
  const pairs = (await mirrorPairs(db)).filter((p) => p.source.id === sourceStoreId);
  if (!pairs.length || !productIds.length) return 0;
  const now = new Date().toISOString();
  let n = 0;
  for (const p of pairs) {
    const rows = [...new Set(productIds)].map((product_id) => ({ store_id: p.mirror.id, product_id, queued_at: now, attempts: 0, last_error: null }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await db.from("mirror_queue").upsert(rows.slice(i, i + 500), { onConflict: "store_id,product_id" });
      if (!error) n += rows.slice(i, i + 500).length;
    }
  }
  return n;
}

/** Produkty źródła, których kopia jeszcze nie ma (ani w kolejce) → do kolejki (pierwsze uzupełnienie katalogu). */
async function enqueueMissing(db: SupabaseClient, pair: MirrorPair, limit: number) {
  const all = async (storeId: string, table: "product_store_links" | "mirror_queue") => {
    const ids = new Set<string>();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db.from(table).select("product_id").eq("store_id", storeId).order("product_id").range(from, from + 999);
      if (error) throw error;
      for (const r of data ?? []) ids.add(r.product_id as string);
      if ((data ?? []).length < 1000) break;
    }
    return ids;
  };
  const [src, have, queued] = await Promise.all([all(pair.source.id, "product_store_links"), all(pair.mirror.id, "product_store_links"), all(pair.mirror.id, "mirror_queue")]);
  const todo = [...src].filter((id) => !have.has(id) && !queued.has(id)).slice(0, limit);
  if (todo.length) {
    const now = new Date().toISOString();
    await db.from("mirror_queue").upsert(todo.map((product_id) => ({ store_id: pair.mirror.id, product_id, queued_at: now })), { onConflict: "store_id,product_id" });
  }
  return { missing: [...src].filter((id) => !have.has(id)).length, queued: todo.length };
}

type SrcVariant = {
  id: string; title: string; sku: string | null; price: string; compareAtPrice: string | null; taxable: boolean; inventoryPolicy: string; position: number;
  barcodes: { nodes: { value: string; type: string | null }[] }; selectedOptions: { name: string; value: string }[];
  inventoryItem: { id: string; tracked: boolean; requiresShipping: boolean } | null;
};
type SrcProduct = {
  id: string; title: string; handle: string; descriptionHtml: string; vendor: string; productType: string; tags: string[]; status: string;
  templateSuffix: string | null; seo: { title: string | null; description: string | null };
  options: { name: string; position: number; values: string[] }[];
  media: { nodes: ({ image?: { url: string; altText: string | null } | null } | null)[] };
  variants: { nodes: SrcVariant[] };
};

const SOURCE_QUERY = `query P($id: ID!) { product(id: $id) {
  id title handle descriptionHtml vendor productType tags status templateSuffix seo { title description }
  options { name position values }
  media(first: 50) { nodes { ... on MediaImage { image { url altText } } } }
  variants(first: 250) { nodes { id title sku price compareAtPrice taxable inventoryPolicy position barcodes(first: 5) { nodes { value type } } selectedOptions { name value } inventoryItem { id tracked requiresShipping } } }
} }`;

const MIRROR_VARIANTS = `query M($id: ID!) { product(id: $id) { id variants(first: 250) { nodes { id selectedOptions { name value } } } } }`;

const SET = `mutation S($identifier: ProductSetIdentifiers, $input: ProductSetInput!) {
  productSet(identifier: $identifier, input: $input, synchronous: true) {
    product { id handle status tags variants(first: 250) { nodes { id sku price compareAtPrice selectedOptions { name value } inventoryItem { id tracked } } } }
    userErrors { field message code }
  }
}`;

const optKey = (opts: { name: string; value: string }[]) => opts.map((o) => `${o.name.toLowerCase()}=${o.value.toLowerCase()}`).join("|");
const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

export type MirrorSettings = { replace: [string, string][] };
export async function mirrorSettings(db: SupabaseClient): Promise<MirrorSettings> {
  const { data } = await db.from("app_settings").select("value").eq("key", "mirror").maybeSingle();
  const v = (data?.value ?? {}) as Partial<MirrorSettings>;
  return { replace: Array.isArray(v.replace) ? v.replace.filter((r) => Array.isArray(r) && r[0]).slice(0, 30) as [string, string][] : [] };
}
const applyReplace = (text: string | null, rules: [string, string][]) => {
  if (!text) return text;
  let t = text;
  for (const [from, to] of rules) t = t.split(from).join(to ?? "");
  return t;
};

let publicationsCache = new Map<string, { at: number; ids: string[] }>();
async function publicationIds(store: MirrorStore) {
  const hit = publicationsCache.get(store.id);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.ids;
  const d = await shopifyGraphql<{ publications: { nodes: { id: string }[] } }>(store.shopify_domain, store.code, `query { publications(first: 30) { nodes { id } } }`);
  const ids = d.publications.nodes.map((n) => n.id);
  publicationsCache.set(store.id, { at: Date.now(), ids });
  return ids;
}

/** Sztuki na stanie rozmiarów w lokalizacjach sklepu źródłowego (stan początkowy nowego produktu w kopii). */
async function sourceCounts(db: SupabaseClient, sourceStoreId: string, variantIds: string[]) {
  const out = new Map<string, number>();
  if (!variantIds.length) return out;
  const { data: locs } = await db.from("locations").select("id").eq("store_id", sourceStoreId).eq("active", true).not("shopify_location_id", "is", null);
  const locIds = (locs ?? []).map((l) => l.id as string);
  if (!locIds.length) return out;
  for (let i = 0; i < variantIds.length; i += 200) {
    const { data } = await db.from("units").select("variant_id").eq("status", "in_stock").in("location_id", locIds).in("variant_id", variantIds.slice(i, i + 200));
    for (const u of data ?? []) out.set(u.variant_id as string, (out.get(u.variant_id as string) ?? 0) + 1);
  }
  return out;
}

/** Produkt usunięty w źródle → w kopii archiwum (bez usuwania – zamówienia i historia zostają), powiązania znikają. */
export async function archiveInMirror(db: SupabaseClient, mirror: MirrorStore, productId: string) {
  const { data: link } = await db.from("product_store_links").select("shopify_product_id").eq("store_id", mirror.id).eq("product_id", productId).maybeSingle();
  if (link?.shopify_product_id) {
    const d = await shopifyGraphql<{ productSet: { userErrors: { message: string }[] } }>(mirror.shopify_domain, mirror.code, SET,
      { identifier: { id: link.shopify_product_id }, input: { status: "ARCHIVED" } });
    const err = d.productSet.userErrors.map((e) => e.message).join("; ");
    if (err && !/not exist|not found/i.test(err)) throw new Error(`Shopify ${mirror.name}: ${err}`);
  }
  const { data: vs } = await db.from("variants").select("id").eq("product_id", productId);
  const ids = (vs ?? []).map((v) => v.id as string);
  if (ids.length) await db.from("variant_store_links").delete().eq("store_id", mirror.id).in("variant_id", ids);
  await db.from("product_store_links").delete().eq("store_id", mirror.id).eq("product_id", productId);
  return "archiwum";
}

/** Utworzenie albo aktualizacja jednego produktu w kopii. Zwraca opis wyniku. */
export async function mirrorProduct(db: SupabaseClient, pair: MirrorPair, productId: string, settings?: MirrorSettings): Promise<string> {
  const { mirror, source } = pair;
  if (!mirror.mirror_location_id) throw new Error(`${mirror.name}: wybierz lokalizację Shopify kopii (Ustawienia → Sklepy i lokalizacje).`);
  const { data: srcLink } = await db.from("product_store_links").select("shopify_product_id").eq("store_id", source.id).eq("product_id", productId).order("updated_at", { ascending: false }).limit(1).maybeSingle();
  if (!srcLink?.shopify_product_id) return archiveInMirror(db, mirror, productId);
  const src = (await shopifyGraphql<{ product: SrcProduct | null }>(source.shopify_domain, source.code, SOURCE_QUERY, { id: srcLink.shopify_product_id })).product;
  if (!src) return archiveInMirror(db, mirror, productId);

  const rules = (settings ?? (await mirrorSettings(db))).replace;
  const [{ data: srcVarLinks }, { data: mirLink }] = await Promise.all([
    db.from("variant_store_links").select("variant_id, shopify_variant_id").eq("store_id", source.id).in("shopify_variant_id", src.variants.nodes.map((v) => v.id)),
    db.from("product_store_links").select("shopify_product_id, mirror_hash, mirror_media_hash").eq("store_id", mirror.id).eq("product_id", productId).maybeSingle(),
  ]);
  const variantOfSrc = new Map((srcVarLinks ?? []).map((l) => [l.shopify_variant_id as string, l.variant_id as string]));

  // Istniejący produkt w kopii: rozmiary po opcjach (te same rozmiary zachowują ID – stany i zamówienia bez zmian).
  const oldId = (mirLink?.shopify_product_id as string | undefined) ?? null;
  let existingId = oldId;
  const mirrorVariantByKey = new Map<string, string>();
  if (existingId) {
    const m = (await shopifyGraphql<{ product: { id: string; variants: { nodes: { id: string; selectedOptions: { name: string; value: string }[] }[] } } | null }>(
      mirror.shopify_domain, mirror.code, MIRROR_VARIANTS, { id: existingId })).product;
    if (!m) existingId = null; // usunięty ręcznie w kopii – tworzymy od nowa
    else for (const v of m.variants.nodes) mirrorVariantByKey.set(optKey(v.selectedOptions), v.id);
  }

  // Produkt w archiwum źródła, którego kopia jeszcze nie ma – nie tworzymy go.
  if (!existingId && src.status === "ARCHIVED") return "bez zmian";
  const counts = existingId ? new Map<string, number>() : await sourceCounts(db, source.id, [...variantOfSrc.values()]);
  const input = {
    title: src.title,
    handle: src.handle,
    descriptionHtml: applyReplace(src.descriptionHtml, rules) ?? "",
    vendor: src.vendor,
    productType: src.productType,
    tags: src.tags,
    status: src.status,
    seo: { title: applyReplace(src.seo.title, rules), description: applyReplace(src.seo.description, rules) },
    productOptions: [...src.options].sort((a, b) => a.position - b.position).map((o) => ({ name: o.name, position: o.position, values: o.values.map((name) => ({ name })) })),
    variants: [...src.variants.nodes].sort((a, b) => a.position - b.position).map((v) => {
      const key = optKey(v.selectedOptions);
      const ourVariant = variantOfSrc.get(v.id);
      const tracked = v.inventoryItem?.tracked !== false;
      return {
        ...(mirrorVariantByKey.get(key) ? { id: mirrorVariantByKey.get(key) } : {}),
        optionValues: v.selectedOptions.map((o) => ({ optionName: o.name, name: o.value })),
        position: v.position,
        sku: v.sku ?? undefined,
        price: v.price,
        compareAtPrice: v.compareAtPrice,
        taxable: v.taxable,
        inventoryPolicy: v.inventoryPolicy,
        ...(v.barcodes.nodes.length ? { barcodes: v.barcodes.nodes.map((b) => ({ value: b.value, ...(b.type ? { type: b.type } : {}) })) } : {}),
        inventoryItem: { tracked, requiresShipping: v.inventoryItem?.requiresShipping ?? true },
        // Nowy produkt: stan od razu (sztuki źródła); później stany wysyła zapis „aplikacja → Shopify”.
        ...(!existingId && tracked ? { inventoryQuantities: [{ locationId: mirror.mirror_location_id, name: "available", quantity: ourVariant ? counts.get(ourVariant) ?? 0 : 0 }] } : {}),
      };
    }),
  };
  const images = src.media.nodes.map((n) => n?.image).filter((i): i is { url: string; altText: string | null } => !!i?.url);
  const hash = sha({ ...input, variants: input.variants.map(({ inventoryQuantities: _q, id: _id, ...v }) => v) });
  const mediaHash = sha(images.map((i) => [i.url.split("?")[0], i.altText]));
  if (existingId && mirLink?.mirror_hash === hash && mirLink?.mirror_media_hash === mediaHash) {
    await db.from("product_store_links").update({ mirrored_at: new Date().toISOString() }).eq("store_id", mirror.id).eq("product_id", productId);
    return "bez zmian";
  }
  const files = !existingId || mirLink?.mirror_media_hash !== mediaHash
    ? images.map((i) => ({ originalSource: i.url, alt: i.altText ?? src.title, contentType: "IMAGE" }))
    : undefined;

  type SetResult = { productSet: { product: { id: string; handle: string; status: string; tags: string[]; variants: { nodes: { id: string; sku: string | null; price: string; compareAtPrice: string | null; selectedOptions: { name: string; value: string }[]; inventoryItem: { id: string; tracked: boolean } | null }[] } } | null; userErrors: { field: string[] | null; message: string; code: string | null }[] } };
  const send = (inp: Record<string, unknown>) => shopifyGraphql<SetResult>(mirror.shopify_domain, mirror.code, SET,
    { identifier: existingId ? { id: existingId } : null, input: { ...inp, ...(files ? { files } : {}) } });
  let d = await send(input);
  // Adres (handle) zajęty w kopii przez inny produkt – Shopify nada własny.
  if (d.productSet.userErrors.some((e) => (e.field ?? []).includes("handle") || /handle/i.test(e.message))) {
    const { handle: _h, ...rest } = input;
    d = await send(rest);
  }
  const errs = d.productSet.userErrors;
  if (errs.length || !d.productSet.product) throw new Error(`Shopify ${mirror.name}: ${errs.map((e) => e.message).join("; ") || "brak produktu w odpowiedzi"}`);
  const made = d.productSet.product;
  if (!existingId) {
    // Widoczny we wszystkich kanałach sprzedaży kopii (sklep internetowy, Shop itd.).
    const pubs = await publicationIds(mirror).catch(() => []);
    if (pubs.length) {
      await shopifyGraphql(mirror.shopify_domain, mirror.code,
        `mutation P($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) { userErrors { field message } } }`,
        { id: made.id, input: pubs.map((publicationId) => ({ publicationId })) }).catch(() => null);
    }
  }

  // Powiązania kopii z tymi samymi produktami / rozmiarami aplikacji (te same sztuki).
  const now = new Date().toISOString();
  const { error: pe } = await db.from("product_store_links").upsert({
    product_id: productId, store_id: mirror.id, shopify_product_id: made.id, handle: made.handle, status: made.status, tags: made.tags,
    mirror_hash: hash, mirror_media_hash: mediaHash, mirrored_at: now, updated_at: now,
  }, { onConflict: "store_id,shopify_product_id" });
  if (pe) throw pe;
  if (oldId && oldId !== made.id) await db.from("product_store_links").delete().eq("store_id", mirror.id).eq("shopify_product_id", oldId);
  const srcByKey = new Map(src.variants.nodes.map((v) => [optKey(v.selectedOptions), v]));
  const rows = made.variants.nodes.flatMap((mv) => {
    const sv = srcByKey.get(optKey(mv.selectedOptions));
    const variantId = sv ? variantOfSrc.get(sv.id) : undefined;
    if (!variantId || mv.inventoryItem?.tracked === false) return [];
    return [{
      variant_id: variantId, store_id: mirror.id, shopify_variant_id: mv.id, shopify_inventory_item_id: mv.inventoryItem?.id ?? null,
      inventory_tracked: true, price: Number(mv.price), compare_at_price: mv.compareAtPrice ? Number(mv.compareAtPrice) : null, sku: mv.sku || null, updated_at: now,
    }];
  });
  if (rows.length) {
    const { error } = await db.from("variant_store_links").upsert(rows, { onConflict: "store_id,shopify_variant_id" });
    if (error) throw error;
  }
  // Rozmiary usunięte w źródle – powiązania kopii też znikają.
  const { data: oldLinks } = await db.from("variants").select("id").eq("product_id", productId);
  const live = new Set(made.variants.nodes.map((v) => v.id));
  const allIds = (oldLinks ?? []).map((v) => v.id as string);
  if (allIds.length) {
    const { data: stale } = await db.from("variant_store_links").select("shopify_variant_id").eq("store_id", mirror.id).in("variant_id", allIds);
    const gone = (stale ?? []).map((s) => s.shopify_variant_id as string).filter((g) => g && !live.has(g));
    if (gone.length) await db.from("variant_store_links").delete().eq("store_id", mirror.id).in("shopify_variant_id", gone);
  }
  return existingId ? "zaktualizowany" : "utworzony";
}

/**
 * Przebieg kopii: najpierw zmiany z kolejki, potem brakujące produkty (do limitu czasu).
 * Błędy produktu zostają w kolejce (do 8 prób, potem widoczne w Ustawieniach).
 */
export async function runMirror(db: SupabaseClient, opts: { deadline: number; backfill?: number } = { deadline: Date.now() + 60_000 }) {
  const pairs = await mirrorPairs(db, true);
  const out: Record<string, unknown> = {};
  const settings = await mirrorSettings(db);
  for (const pair of pairs) {
    const stats = { utworzone: 0, zaktualizowane: 0, bez_zmian: 0, archiwum: 0, bledy: 0, brakuje: 0 } as Record<string, number>;
    const errors: string[] = [];
    try {
      if (!pair.mirror.mirror_location_id) { out[pair.mirror.name] = "wybierz lokalizację Shopify kopii w Ustawieniach"; continue; }
      const miss = await enqueueMissing(db, pair, opts.backfill ?? 300);
      stats.brakuje = miss.missing;
      while (Date.now() < opts.deadline) {
        const { data: batch } = await db.from("mirror_queue").select("product_id, attempts").eq("store_id", pair.mirror.id).lt("attempts", 8)
          .order("attempts").order("queued_at").limit(10);
        if (!batch?.length) break;
        for (const q of batch) {
          if (Date.now() >= opts.deadline) break;
          try {
            const r = await mirrorProduct(db, pair, q.product_id as string, settings);
            stats[r === "utworzony" ? "utworzone" : r === "zaktualizowany" ? "zaktualizowane" : r === "archiwum" ? "archiwum" : "bez_zmian"]++;
            await db.from("mirror_queue").delete().eq("store_id", pair.mirror.id).eq("product_id", q.product_id);
          } catch (e) {
            stats.bledy++;
            if (errors.length < 3) errors.push(errorMessage(e));
            await db.from("mirror_queue").update({ attempts: Number(q.attempts ?? 0) + 1, last_error: errorMessage(e).slice(0, 500) }).eq("store_id", pair.mirror.id).eq("product_id", q.product_id);
          }
        }
      }
      const { count } = await db.from("mirror_queue").select("product_id", { count: "exact", head: true }).eq("store_id", pair.mirror.id).lt("attempts", 8);
      out[pair.mirror.name] = { ...Object.fromEntries(Object.entries(stats).filter(([, v]) => v)), w_kolejce: count ?? 0, ...(errors.length ? { errors } : {}) };
    } catch (e) {
      out[pair.mirror.name] = `błąd: ${errorMessage(e)}`;
    }
  }
  return out;
}
