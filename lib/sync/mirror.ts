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
  barcode: string | null; selectedOptions: { name: string; value: string }[];
  inventoryItem: { id: string; tracked: boolean; requiresShipping: boolean } | null;
};
type SrcProduct = {
  id: string; title: string; handle: string; descriptionHtml: string; vendor: string; productType: string; tags: string[]; status: string;
  templateSuffix: string | null; seo: { title: string | null; description: string | null };
  options: { name: string; position: number; values: string[] }[];
  media: { pageInfo?: { hasNextPage: boolean }; nodes: ({ image?: { url: string; altText: string | null } | null } | null)[] };
  variants: { pageInfo?: { hasNextPage: boolean }; nodes: SrcVariant[] };
};

const SOURCE_QUERY = `query P($id: ID!) { product(id: $id) {
  id title handle descriptionHtml vendor productType tags status templateSuffix seo { title description }
  options { name position values }
  media(first: 50) { pageInfo { hasNextPage } nodes { ... on MediaImage { image { url altText } } } }
  variants(first: 250) { pageInfo { hasNextPage } nodes { id title sku price compareAtPrice taxable inventoryPolicy position barcode selectedOptions { name value } inventoryItem { id tracked requiresShipping } } }
} }`;

const MIRROR_VARIANTS = `query M($id: ID!) { product(id: $id) { id variants(first: 250) { nodes { id selectedOptions { name value } } } } }`;

const SET = `mutation S($identifier: ProductSetIdentifiers, $input: ProductSetInput!) {
  productSet(identifier: $identifier, input: $input, synchronous: true) {
    product { id handle status tags variants(first: 250) { nodes { id sku price compareAtPrice selectedOptions { name value } inventoryItem { id tracked } } } }
    userErrors { field message code }
  }
}`;

const optKey = (opts: { name: string; value: string }[]) => opts.map((o) => `${o.name.trim().toLowerCase()}=${o.value.trim().toLowerCase()}`).join("|");
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
  // Ponad 250 rozmiarów – zapis listy rozmiarów usunąłby w kopii te nieodczytane; bez zmian, do ręcznej decyzji.
  if (src.variants.pageInfo?.hasNextPage) throw new Error(`${src.title}: ponad 250 rozmiarów – kopia tego produktu nie jest obsługiwana`);

  const rules = (settings ?? (await mirrorSettings(db))).replace;
  const [{ data: srcVarLinks }, { data: mirLinks, error: mlErr }] = await Promise.all([
    db.from("variant_store_links").select("variant_id, shopify_variant_id").eq("store_id", source.id).in("shopify_variant_id", src.variants.nodes.map((v) => v.id)),
    db.from("product_store_links").select("shopify_product_id, mirror_hash, mirror_media_hash").eq("store_id", mirror.id).eq("product_id", productId).order("mirrored_at", { ascending: false, nullsFirst: false }).limit(1),
  ]);
  if (mlErr) throw mlErr;
  const mirLink = mirLinks?.[0] ?? null;
  const variantOfSrc = new Map((srcVarLinks ?? []).map((l) => [l.shopify_variant_id as string, l.variant_id as string]));

  // Produkt w kopii: zapisany przy produkcie, a gdy go nie ma – ten sam adres (handle) w kopii (np. dodany wcześniej ręcznie).
  const oldId = (mirLink?.shopify_product_id as string | undefined) ?? null;
  let existingId = oldId;
  type MV = { id: string; selectedOptions: { name: string; value: string }[] };
  let mirrorVariants: MV[] = [];
  const readMirror = async (id: string) => (await shopifyGraphql<{ product: { id: string; variants: { nodes: MV[] } } | null }>(mirror.shopify_domain, mirror.code, MIRROR_VARIANTS, { id })).product;
  if (existingId) {
    const m = await readMirror(existingId);
    if (!m) existingId = null; // usunięty ręcznie w kopii
    else mirrorVariants = m.variants.nodes;
  }
  if (!existingId) {
    const byHandle = (await shopifyGraphql<{ productByIdentifier: { id: string } | null }>(mirror.shopify_domain, mirror.code,
      `query H($h: String!) { productByIdentifier(identifier: { handle: $h }) { id } }`, { h: src.handle })).productByIdentifier;
    if (byHandle) {
      const { data: taken } = await db.from("product_store_links").select("product_id").eq("store_id", mirror.id).eq("shopify_product_id", byHandle.id).limit(1);
      if (taken?.length && taken[0].product_id !== productId) throw new Error(`${src.title}: adres „${src.handle}” w ${mirror.name} ma już inny produkt kopii`);
      existingId = byHandle.id;
      mirrorVariants = (await readMirror(byHandle.id))?.variants.nodes ?? [];
    }
  }

  // Produkt w archiwum źródła, którego kopia jeszcze nie ma – nie tworzymy go.
  if (!existingId && src.status === "ARCHIVED") return "bez zmian";
  // Rozmiary kopii: po rozmiarze aplikacji (zapisane powiązanie), a dopiero potem po opcjach.
  const { data: ownLinks } = await db.from("variant_store_links").select("variant_id, shopify_variant_id").eq("store_id", mirror.id).in("variant_id", [...new Set(variantOfSrc.values())]);
  const liveMirror = new Set(mirrorVariants.map((v) => v.id));
  const mirrorByOur = new Map((ownLinks ?? []).filter((l) => liveMirror.has(l.shopify_variant_id as string)).map((l) => [l.variant_id as string, l.shopify_variant_id as string]));
  const mirrorByKey = new Map(mirrorVariants.map((v) => [optKey(v.selectedOptions), v.id]));
  const used = new Set<string>();
  const counts = await sourceCounts(db, source.id, [...variantOfSrc.values()]);
  const sorted = [...src.variants.nodes].sort((a, b) => a.position - b.position);
  const sentIdOf = new Map<string, SrcVariant>(); // ID rozmiaru kopii → rozmiar źródła
  const input = {
    title: src.title,
    handle: src.handle,
    descriptionHtml: applyReplace(src.descriptionHtml, rules) ?? "",
    vendor: src.vendor,
    productType: src.productType,
    tags: src.tags,
    status: src.status,
    seo: { title: applyReplace(src.seo.title, rules), description: applyReplace(src.seo.description, rules) },
    productOptions: [...src.options].sort((a, b) => a.position - b.position).map((o, i) => ({ name: o.name, position: i + 1, values: o.values.map((name) => ({ name })) })),
    variants: sorted.map((v, i) => {
      const ourVariant = variantOfSrc.get(v.id);
      let id = ourVariant ? mirrorByOur.get(ourVariant) : undefined;
      if (!id || used.has(id)) id = mirrorByKey.get(optKey(v.selectedOptions));
      if (id && used.has(id)) id = undefined;
      if (id) { used.add(id); sentIdOf.set(id, v); }
      const tracked = v.inventoryItem?.tracked !== false;
      return {
        ...(id ? { id } : {}),
        optionValues: v.selectedOptions.map((o) => ({ optionName: o.name, name: o.value })),
        // Kolejność jak w źródle, numerowana od 1 bez dziur (Shopify odrzuca pozycje spoza 1…liczba rozmiarów).
        position: i + 1,
        sku: v.sku ?? undefined,
        price: v.price,
        compareAtPrice: v.compareAtPrice,
        taxable: v.taxable,
        // Wspólne sztuki – kopia nigdy nie sprzedaje „na minus”.
        inventoryPolicy: "DENY",
        // Kod kreskowy (EAN) – API 2026-07: pole barcode (tekst).
        ...(v.barcode ? { barcode: v.barcode } : {}),
        inventoryItem: { tracked, requiresShipping: v.inventoryItem?.requiresShipping ?? true },
        // Nowy rozmiar w kopii: stan od razu (sztuki źródła); później stany wysyła zapis „aplikacja → Shopify”.
        ...(!id && tracked ? { inventoryQuantities: [{ locationId: mirror.mirror_location_id, name: "available", quantity: ourVariant ? counts.get(ourVariant) ?? 0 : 0 }] } : {}),
      };
    }),
  };
  const images = src.media.nodes.map((n) => n?.image).filter((i): i is { url: string; altText: string | null } => !!i?.url);
  const hash = sha({ ...input, variants: input.variants.map(({ inventoryQuantities: _q, id: _id, ...v }) => v) });
  const mediaHash = sha(images.map((i) => [i.url.split("?")[0], i.altText]));
  if (existingId && existingId === oldId && mirLink?.mirror_hash === hash && mirLink?.mirror_media_hash === mediaHash) {
    await db.from("product_store_links").update({ mirrored_at: new Date().toISOString() }).eq("store_id", mirror.id).eq("product_id", productId);
    return "bez zmian";
  }
  // Zdjęcia tylko gdy się zmieniły (lista zastępuje zdjęcia w kopii); ponad 50 zdjęć – bez zmian zdjęć.
  const files = !src.media.pageInfo?.hasNextPage && (existingId !== oldId || mirLink?.mirror_media_hash !== mediaHash)
    ? images.map((i) => ({ originalSource: i.url, alt: i.altText ?? src.title, contentType: "IMAGE" }))
    : undefined;

  type SetResult = { productSet: { product: { id: string; handle: string; status: string; tags: string[]; variants: { nodes: { id: string; sku: string | null; price: string; compareAtPrice: string | null; selectedOptions: { name: string; value: string }[]; inventoryItem: { id: string; tracked: boolean } | null }[] } } | null; userErrors: { field: string[] | null; message: string; code: string | null }[] } };
  const d = await shopifyGraphql<SetResult>(mirror.shopify_domain, mirror.code, SET,
    { identifier: existingId ? { id: existingId } : null, input: { ...input, ...(files ? { files } : {}) } });
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
  if (oldId && oldId !== made.id) await db.from("product_store_links").delete().eq("store_id", mirror.id).eq("shopify_product_id", oldId);
  const { error: pe } = await db.from("product_store_links").upsert({
    product_id: productId, store_id: mirror.id, shopify_product_id: made.id, handle: made.handle, status: made.status, tags: made.tags,
    mirror_hash: hash, mirror_media_hash: mediaHash, mirrored_at: now, updated_at: now,
  }, { onConflict: "store_id,shopify_product_id" });
  if (pe) throw pe;
  const srcByKey = new Map(src.variants.nodes.map((v) => [optKey(v.selectedOptions), v]));
  const untracked: string[] = [];
  const rows = made.variants.nodes.flatMap((mv) => {
    const sv = sentIdOf.get(mv.id) ?? srcByKey.get(optKey(mv.selectedOptions));
    const variantId = sv ? variantOfSrc.get(sv.id) : undefined;
    if (mv.inventoryItem?.tracked === false || !variantId) { untracked.push(mv.id); return []; }
    return [{
      variant_id: variantId, store_id: mirror.id, shopify_variant_id: mv.id, shopify_inventory_item_id: mv.inventoryItem?.id ?? null,
      inventory_tracked: true, price: Number(mv.price), compare_at_price: mv.compareAtPrice ? Number(mv.compareAtPrice) : null, sku: mv.sku || null, updated_at: now,
    }];
  });
  if (rows.length) {
    const { error } = await db.from("variant_store_links").upsert(rows, { onConflict: "store_id,shopify_variant_id" });
    if (error) throw error;
  }
  // Rozmiary bez śledzenia stanu / bez rozmiaru w aplikacji – bez powiązania (zamówienie nie zdejmie z nich sztuki).
  if (untracked.length) await db.from("variant_store_links").delete().eq("store_id", mirror.id).in("shopify_variant_id", untracked);
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
 * Jeden przebieg naraz na produkt (webhook, automat, przycisk): zajęcie wiersza kolejki na 5 minut.
 * Zwraca false, gdy produkt jest właśnie kopiowany gdzie indziej.
 */
async function claim(db: SupabaseClient, mirrorId: string, productId: string) {
  const { data, error } = await db.rpc("mirror_claim", { p_store: mirrorId, p_product: productId });
  if (error) return /mirror_claim|schema cache/i.test(error.message); // bez funkcji (starsza wersja SQL 78) – bez blokady
  return data === true;
}

/** Kopiowanie jednego produktu z zajęciem kolejki (webhook / automat). Wynik albo null, gdy zajęty. */
export async function mirrorNow(db: SupabaseClient, pair: MirrorPair, productId: string, settings?: MirrorSettings) {
  if (!(await claim(db, pair.mirror.id, productId))) return null;
  try {
    const r = await mirrorProduct(db, pair, productId, settings);
    await db.from("mirror_queue").delete().eq("store_id", pair.mirror.id).eq("product_id", productId);
    return r;
  } catch (e) {
    const { data: q } = await db.from("mirror_queue").select("attempts").eq("store_id", pair.mirror.id).eq("product_id", productId).maybeSingle();
    await db.from("mirror_queue").update({ attempts: Number(q?.attempts ?? 0) + 1, last_error: errorMessage(e).slice(0, 500), claimed_at: null })
      .eq("store_id", pair.mirror.id).eq("product_id", productId);
    throw e;
  }
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
    const skipped = new Set<string>(); // właśnie kopiowane gdzie indziej
    try {
      if (!pair.mirror.mirror_location_id) { out[pair.mirror.name] = "wybierz lokalizację Shopify kopii w Ustawieniach"; continue; }
      const miss = await enqueueMissing(db, pair, opts.backfill ?? 300);
      stats.brakuje = miss.missing;
      while (Date.now() < opts.deadline) {
        const { data: rows } = await db.from("mirror_queue").select("product_id, attempts").eq("store_id", pair.mirror.id).lt("attempts", 8)
          .order("attempts").order("queued_at").limit(10 + skipped.size);
        const batch = (rows ?? []).filter((r) => !skipped.has(r.product_id as string)).slice(0, 10);
        if (!batch.length) break;
        for (const q of batch) {
          if (Date.now() >= opts.deadline) break;
          try {
            const r = await mirrorNow(db, pair, q.product_id as string, settings);
            if (r === null) { skipped.add(q.product_id as string); continue; }
            stats[r === "utworzony" ? "utworzone" : r === "zaktualizowany" ? "zaktualizowane" : r === "archiwum" ? "archiwum" : "bez_zmian"]++;
          } catch (e) {
            stats.bledy++;
            if (errors.length < 3) errors.push(errorMessage(e));
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
