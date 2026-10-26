import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { collectionByHandle, lowestPriceDefinitions, omnibusMetafields, productsInCollection, readMetafields } from "@/lib/integrations/shopify";

/** Definicje metapola „Lowest price” (Omnibus Insight) w sklepie – pamiętane 6 godzin. */
const defsCache = new Map<string, { at: number; defs: Awaited<ReturnType<typeof lowestPriceDefinitions>> }>();
async function defsFor(domain: string, code: string) {
  const hit = defsCache.get(domain);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.defs;
  const defs = await lowestPriceDefinitions(domain, code).catch(() => ({ variant: [], product: [] }));
  defsCache.set(domain, { at: Date.now(), defs });
  return defs;
}

/**
 * Metka sklepowa: cena modelu (zakres po wszystkich rozmiarach w sklepie), promocja (cena przed obniżką)
 * i najniższa cena z 30 dni przed obniżką (Omnibus): z metapola aplikacji Omnibus w Shopify, a gdy go nie ma –
 * z historii cen zapisywanej przez aplikację.
 */

export type Range = { min: number; max: number } | null;
export type PriceTag = {
  unitId: string; code: string; title: string; option: string; sku: string; skuIsBase: boolean;
  price: Range; compareAt: Range; promo: boolean; lowest30: Range; lowestSource: string; storeName: string; used: boolean;
  /** IMEI / numer seryjny sztuki (telefony) – drukowany na metce. */
  identifier?: string | null;
  /** Metka produktu (Stan produktu + metka): bez rozmiaru, kod PR… prowadzi do rozmiarów produktu. */
  productTag?: boolean;
  /** Metka sztuki z cenami (produkt spoza kolekcji „Nowości Buty”): cena rozmiaru, cena przed obniżką, Omnibus i ramka rozmiaru. */
  showPrices?: boolean;
};

type TagSource = { id: string; code: string; identifier: string | null; variant_id: string; variant: { option: string; product_id: string; product: { title: string; style_sku: string | null } }; location: { store_id: string; store: { name: string; code: string; shopify_domain: string | null } } };

/** Używane: produkt ma w Shopify tag „reused” (w sklepie sztuki, a gdy go tam nie ma – w którymkolwiek). */
export function isReused(links: { store_id: string; tags?: string[] | null }[], storeId?: string) {
  const has = (l: { tags?: string[] | null }) => (l.tags ?? []).some((t) => t.trim().toLowerCase() === "reused");
  const own = storeId ? links.filter((l) => l.store_id === storeId) : [];
  return (own.length ? own : links).some(has);
}

/**
 * Najniższa cena z bloku Omnibus Insight na stronie produktu w sklepie (blok aplikacji w motywie).
 * Zwraca kwotę albo null, gdy blok się nie wyświetla (np. tylko przy promocjach) albo strona nie odpowiada.
 */
export async function storefrontLowest(domain: string, handle: string, variantGid: string | null): Promise<number | null> {
  const vid = variantGid?.split("/").pop();
  try {
    const res = await fetch(`https://${domain}/products/${encodeURIComponent(handle)}${vid ? `?variant=${vid}` : ""}`, { redirect: "follow", signal: AbortSignal.timeout(6000), headers: { "user-agent": "MagazynApp/1.0 (metka)" } });
    if (!res.ok) return null;
    const text = (await res.text()).replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/\s+/g, " ");
    const m = text.match(/(?:najni[żz]sz\w*\s+cen\w*|lowest\s+price)[\s\S]{0,160}?(\d{1,3}(?:[ .\u00a0]?\d{3})*(?:[.,]\d{1,2})?)\s*(?:zł|pln)/i);
    if (!m) return null;
    const n = Number(m[1].replace(/[ .\u00a0](?=\d{3}\b)/g, "").replace(",", "."));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Rozmiar na metce: rzeczy bez rozmiaru („One size”, „Default Title” ze Shopify, „uniwersalny”) – „N/A”.
 * Jeden prawdziwy rozmiar (np. używana para 43 jako osobny produkt) zostaje.
 */
function sizeLabel(option: string) {
  const o = (option ?? "").trim();
  if (!o || /^(default title|os|o\/s|n\/?a|-|–|brak)$/i.test(o) || /one\s*-?\s*size|onesize|uniwersaln|universal|jeden rozmiar/i.test(o)) return "N/A";
  return o;
}

async function pool<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

const range = (vals: (number | null | undefined)[]): Range => {
  const v = vals.filter((x): x is number => typeof x === "number" && Number.isFinite(x) && x > 0);
  return v.length ? { min: Math.min(...v), max: Math.max(...v) } : null;
};

export const fmtRange = (r: Range) => {
  if (!r) return "–";
  const f = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(".", ","));
  return r.min === r.max ? `${f(r.min)} PLN` : `${f(r.min)}–${f(r.max)} PLN`;
};

type Hist = { variant_id: string; price: number; valid_from: string };

/** Najniższa cena z 30 dni przed obecną obniżką (albo z ostatnich 30 dni, gdy obniżki nie ma) – z historii aplikacji. */
export function lowestFromHistory(rows: Hist[], current: number, now = Date.now()) {
  const asc = [...rows].sort((a, b) => a.valid_from.localeCompare(b.valid_from));
  if (!asc.length) return { value: null as number | null, complete: false };
  // Początek obecnej ceny: najwcześniejszy wpis z ostatniego ciągu tej samej ceny.
  let start = asc.length - 1;
  while (start > 0 && Number(asc[start - 1].price) === current) start--;
  const reduced = start > 0 && Number(asc[start - 1].price) > current;
  const to = reduced ? new Date(asc[start].valid_from).getTime() : now;
  const from = to - 30 * 86400_000;
  let min: number | null = reduced ? null : current;
  for (let i = 0; i < asc.length; i++) {
    const s = new Date(asc[i].valid_from).getTime();
    const e = i + 1 < asc.length ? new Date(asc[i + 1].valid_from).getTime() : now;
    if (e > from && s < to) min = min === null ? Number(asc[i].price) : Math.min(min, Number(asc[i].price));
  }
  return { value: min, complete: new Date(asc[0].valid_from).getTime() <= from };
}

/** Liczba z metapola Omnibus (liczba, kwota albo JSON z kwotą). */
function mfNumber(m: { type: string; value: string }): number | null {
  const direct = Number(String(m.value).replace(",", "."));
  if (Number.isFinite(direct) && direct > 0) return direct;
  try {
    const j = JSON.parse(m.value) as unknown;
    if (j && typeof j === "object") {
      for (const k of ["amount", "lowest_price", "lowestPrice", "price", "value", "min"]) {
        const v = Number((j as Record<string, unknown>)[k]);
        if (Number.isFinite(v) && v > 0) return v;
      }
    }
  } catch {
    // nie JSON
  }
  return null;
}

export async function priceTags(db: SupabaseClient, unitIds: string[]) {
  const { data: units } = await db.from("units")
    .select("id, code, identifier, variant_id, variant:variants(option, product_id, product:products(title, style_sku)), location:locations(store_id, store:stores(name, code, shopify_domain))")
    .in("id", unitIds.slice(0, 200)).order("number");
  const list = (units ?? []) as unknown as TagSource[];
  // Nowe buty (kolekcja „Nowości Buty” w Shopify): metka bez cen – sklep, nazwa, rozmiar, IMEI i kod.
  // Reszta (używane, ubrania, akcesoria…): cena tego rozmiaru, cena przed obniżką i najniższa z 30 dni.
  const isNew = await newShoes(db, list);
  const plain = list.filter((u) => isNew(u.variant.product_id, u.location.store_id));
  const priced = list.filter((u) => !isNew(u.variant.product_id, u.location.store_id));
  const [a, b] = await Promise.all([
    plain.length ? buildTags(db, plain, false) : Promise.resolve([]),
    priced.length ? buildTags(db, priced, true, true) : Promise.resolve([]),
  ]);
  const byId = new Map([...a, ...b.map((t) => ({ ...t, showPrices: true }))].map((t) => [t.unitId, t]));
  return list.map((u) => byId.get(u.id)!).filter(Boolean);
}

const NEW_SHOES = /^nowo[sś]ci\s*buty$/i;
const newShoesGid = new Map<string, { at: number; gid: string | null }>();

/** Kolekcja „Nowości Buty” sklepu: z pobranych kolekcji (SQL 58), a gdy ich nie ma – ze Shopify po adresie. */
async function newShoesCollection(db: SupabaseClient, store: { id: string; code: string; domain: string }) {
  const hit = newShoesGid.get(store.id);
  if (hit && Date.now() - hit.at < 3600_000) return hit.gid;
  let gid: string | null = null;
  const { data, error } = await db.from("shop_collections").select("gid, title, handle").eq("store_id", store.id);
  if (!error && data?.length) gid = (data.find((c) => c.handle === "nowosci-buty") ?? data.find((c) => NEW_SHOES.test(String(c.title).trim())))?.gid as string ?? null;
  else gid = (await collectionByHandle(store.domain, store.code, "nowosci-buty"))?.id ?? null;
  newShoesGid.set(store.id, { at: Date.now(), gid });
  return gid;
}

/**
 * Czy produkt jest w kolekcji „Nowości Buty” sklepu sztuki – sprawdzane na żywo w Shopify (nowe produkty trafiają
 * do kolekcji od razu), a przy błędzie – z kolekcji zapisanych w aplikacji. Gdy nic nie wiadomo – jak dotąd (bez cen).
 */
async function newShoes(db: SupabaseClient, list: TagSource[]): Promise<(productId: string, storeId: string) => boolean> {
  const productIds = [...new Set(list.map((u) => u.variant.product_id))];
  if (!productIds.length) return () => false;
  const [links, prods] = await Promise.all([
    chunked<{ product_id: string; store_id: string; shopify_product_id: string | null }>(productIds, 100, (part) => db.from("product_store_links").select("product_id, store_id, shopify_product_id").in("product_id", part).limit(5000)),
    chunked<{ id: string; collections?: string[] | null }>(productIds, 100, (part) => db.from("products").select("*").in("id", part)),
  ]);
  const fromDb = new Map(prods.map((p) => [p.id, Array.isArray(p.collections) && p.collections.length ? p.collections.some((c) => NEW_SHOES.test(c.trim())) : null]));
  const answer = new Map<string, boolean | null>(); // productId|storeId
  const stores = new Map<string, { id: string; code: string; domain: string | null }>();
  for (const u of list) stores.set(u.location.store_id, { id: u.location.store_id, code: u.location.store.code, domain: u.location.store.shopify_domain });
  await Promise.all([...stores.values()].map(async (st) => {
    const keys = productIds.filter((pid) => list.some((u) => u.variant.product_id === pid && u.location.store_id === st.id));
    if (!st.domain) { for (const pid of keys) answer.set(`${pid}|${st.id}`, null); return; }
    try {
      const gid = await newShoesCollection(db, { id: st.id, code: st.code, domain: st.domain });
      if (!gid) { for (const pid of keys) answer.set(`${pid}|${st.id}`, false); return; } // sklep bez tej kolekcji (np. Telefoniki)
      const gidOf = new Map(keys.map((pid) => [pid, links.find((l) => l.product_id === pid && l.store_id === st.id)?.shopify_product_id ?? null]));
      const inside = await productsInCollection(st.domain, st.code, gid, [...gidOf.values()].filter((g): g is string => !!g));
      // Produkt bez odpowiednika w tym sklepie – według zapisanych kolekcji.
      for (const pid of keys) answer.set(`${pid}|${st.id}`, gidOf.get(pid) ? inside.has(gidOf.get(pid)!) : fromDb.get(pid) ?? null);
    } catch {
      for (const pid of keys) answer.set(`${pid}|${st.id}`, fromDb.get(pid) ?? null);
    }
  }));
  return (pid, sid) => answer.get(`${pid}|${sid}`) ?? true;
}

/** Zapytania po wielu id w paczkach (limit długości adresu i 1000 wierszy na odpowiedź). */
/** Po kawałkach; kawałek z pełnym 1000 wierszy (limit Supabase, np. historia cen) dzieli się na pół. Błąd = brak danych. */
async function chunked<T>(ids: string[], size: number, fn: (part: string[]) => PromiseLike<{ data: unknown[] | null; error?: unknown }>) {
  return inChunksAll<T>(ids, async (part) => {
    const r = await fn(part as string[]);
    return { data: r.error ? [] : r.data, error: null };
  }, size);
}

import { productTagCode } from "./price-tag-code";
import { inChunksAll } from "@/lib/supabase/paging";
export { productTagCode, parseProductTagCode } from "./price-tag-code";

/** Metki produktów z katalogu (jedna na produkt, bez rozmiaru) – ceny i Omnibus jak na metkach sztuk, w wybranym sklepie. */
export async function productPriceTags(db: SupabaseClient, productIds: string[], storeId: string) {
  const ids = productIds.slice(0, 200);
  const [{ data: products }, { data: store }, { data: variants }] = await Promise.all([
    db.from("products").select("id, title, style_sku, tag_no").in("id", ids),
    db.from("stores").select("id, name, code, shopify_domain").eq("id", storeId).maybeSingle(),
    Promise.resolve({ data: await chunked<{ id: string; product_id: string }>(ids, 50, (part) => db.from("variants").select("id, product_id").in("product_id", part).limit(5000)) }),
  ]);
  if (!store) return [];
  const firstVariant = new Map<string, string>();
  for (const v of variants ?? []) if (!firstVariant.has(v.product_id as string)) firstVariant.set(v.product_id as string, v.id as string);
  const order = new Map(ids.map((id, i) => [id, i]));
  const list: TagSource[] = ((products ?? []) as { id: string; title: string; style_sku: string | null; tag_no: number }[])
    .filter((p) => firstVariant.has(p.id))
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .map((p) => ({
      id: p.id, code: productTagCode(p.tag_no), identifier: null, variant_id: firstVariant.get(p.id)!,
      variant: { option: "", product_id: p.id, product: { title: p.title, style_sku: p.style_sku } },
      location: { store_id: store.id as string, store: { name: store.name as string, code: store.code as string, shopify_domain: (store.shopify_domain as string | null) ?? null } },
    }));
  return (await buildTags(db, list)).map((t) => ({ ...t, productTag: true }));
}

/** `perUnit` – ceny tylko rozmiaru sztuki (metka sztuki); bez – zakres po wszystkich rozmiarach (metka produktu). */
async function buildTags(db: SupabaseClient, list: TagSource[], withPrices = true, perUnit = false) {
  const productIds = [...new Set(list.map((u) => u.variant.product_id))];
  const variants = await chunked<{ id: string; product_id: string }>(productIds, 50, (part) => db.from("variants").select("id, product_id").in("product_id", part).limit(5000));
  const variantIds = (variants ?? []).map((v) => v.id as string);
  const byProduct = new Map<string, string[]>();
  for (const v of variants) byProduct.set(v.product_id as string, [...(byProduct.get(v.product_id as string) ?? []), v.id as string]);
  const since = new Date(Date.now() - 120 * 86400_000).toISOString();
  const [links, hist, plinks] = await Promise.all([
    withPrices ? chunked<Record<string, unknown>>(variantIds, 150, (part) => db.from("variant_store_links").select("variant_id, store_id, price, compare_at_price, base_sku, shopify_variant_id").in("variant_id", part).limit(5000)) : Promise.resolve([]),
    withPrices ? chunked<Record<string, unknown>>(variantIds, 150, (part) => db.from("variant_price_history").select("variant_id, store_id, price, valid_from").in("variant_id", part).gte("valid_from", since).order("valid_from").limit(10000)) : Promise.resolve([]),
    chunked<Record<string, unknown>>(productIds, 100, (part) => db.from("product_store_links").select("product_id, store_id, shopify_product_id, handle, tags").in("product_id", part).limit(5000)),
  ]);
  type L = { variant_id: string; store_id: string; price: number | null; compare_at_price: number | null; base_sku: string | null; shopify_variant_id: string | null };
  const linkRows = (links ?? []) as L[];

  // Metapola Omnibus ze Shopify (raz na produkt i sklep).
  const omni = new Map<string, { product: number | null; variants: Map<string, number>; found: string[] }>();
  for (const key of [...new Set(list.map((u) => `${u.variant.product_id}|${u.location.store_id}`))].slice(0, withPrices ? 60 : 0)) {
    const [pid, sid] = key.split("|");
    const u = list.find((x) => x.variant.product_id === pid && x.location.store_id === sid)!;
    const gid = (plinks ?? []).find((p) => p.product_id === pid && p.store_id === sid)?.shopify_product_id as string | undefined;
    if (!gid || !u.location.store.shopify_domain) continue;
    try {
      const domain = u.location.store.shopify_domain;
      const defs = await defsFor(domain, u.location.store.code);
      const [heur, named] = await Promise.all([
        omnibusMetafields(domain, u.location.store.code, gid),
        readMetafields(domain, u.location.store.code, gid, defs).catch(() => ({ product: [], variants: new Map() })),
      ]);
      // Najpierw metapola z definicji „Lowest price”, potem znalezione po nazwie.
      const mf = {
        product: [...named.product, ...heur.product],
        variants: new Map([...heur.variants.keys(), ...named.variants.keys()].map((k) => [k, [...(named.variants.get(k) ?? []), ...(heur.variants.get(k) ?? [])]])),
      };
      const vmap = new Map<string, number>();
      for (const [vid, ms] of mf.variants) { const n = ms.map(mfNumber).find((x) => x !== null); if (n) vmap.set(vid, n); }
      omni.set(key, {
        product: mf.product.map(mfNumber).find((x) => x !== null) ?? null,
        variants: vmap,
        found: [...mf.product, ...[...mf.variants.values()].flat()].map((m) => `${m.namespace}.${m.key}`),
      });
    } catch {
      // brak dostępu albo błąd Shopify – zostaje historia aplikacji
    }
  }

  // Blok Omnibus Insight na stronie produktu (gdy metapola są prywatne aplikacji): kwota dla każdego rozmiaru.
  const shopLowest = new Map<string, number>();
  const jobs: { key: string; domain: string; handle: string; gid: string | null }[] = [];
  for (const key of [...new Set(list.map((u) => `${u.variant.product_id}|${u.location.store_id}`))].slice(0, withPrices ? 60 : 0)) {
    const [pid, sid] = key.split("|");
    if (omni.get(key)?.product || omni.get(key)?.variants.size) continue;
    const u = list.find((x) => x.variant.product_id === pid && x.location.store_id === sid)!;
    const handle = (plinks ?? []).find((p) => p.product_id === pid && p.store_id === sid)?.handle as string | undefined;
    if (!handle || !u.location.store.shopify_domain) continue;
    // Metka sztuki: tylko rozmiary drukowanych sztuk.
    const vids = perUnit ? [...new Set(list.filter((x) => x.variant.product_id === pid && x.location.store_id === sid).map((x) => x.variant_id))] : byProduct.get(pid) ?? [];
    for (const l of linkRows.filter((x) => x.store_id === sid && vids.includes(x.variant_id) && x.price !== null).slice(0, 20)) {
      jobs.push({ key: `${sid}|${l.variant_id}`, domain: u.location.store.shopify_domain, handle, gid: l.shopify_variant_id });
    }
  }
  const found = await pool(jobs.slice(0, 80), 6, (j) => storefrontLowest(j.domain, j.handle, j.gid));
  jobs.slice(0, 80).forEach((j, k) => { if (found[k]) shopLowest.set(j.key, found[k]!); });

  return list.map((u): PriceTag & { omnibusFields: string[]; historyComplete: boolean } => {
    const storeId = u.location.store_id;
    const vids = perUnit ? [u.variant_id] : byProduct.get(u.variant.product_id) ?? [u.variant_id];
    const inStore = linkRows.filter((l) => l.store_id === storeId && vids.includes(l.variant_id) && l.price !== null);
    const price = range(inStore.map((l) => Number(l.price)));
    const promoRows = inStore.filter((l) => l.compare_at_price !== null && Number(l.compare_at_price) > Number(l.price));
    const compareAt = range(promoRows.map((l) => Number(l.compare_at_price)));
    const o = omni.get(`${u.variant.product_id}|${storeId}`);
    let lowestSource = "historia cen aplikacji";
    let complete = true;
    const lows = inStore.map((l) => {
      const fromMf = o?.variants.get(l.shopify_variant_id ?? "") ?? o?.product ?? null;
      if (fromMf) { lowestSource = "aplikacja Omnibus (Shopify)"; return fromMf; }
      const fromShop = shopLowest.get(`${storeId}|${l.variant_id}`);
      if (fromShop) { lowestSource = "Omnibus Insight (strona sklepu)"; return fromShop; }
      const r = lowestFromHistory(((hist ?? []) as (Hist & { store_id: string })[]).filter((h) => h.variant_id === l.variant_id && h.store_id === storeId), Number(l.price));
      if (!r.complete) complete = false;
      return r.value ?? Number(l.price);
    });
    return {
      unitId: u.id, code: u.code, identifier: u.identifier, title: u.variant.product.title, option: sizeLabel(u.variant.option), sku: u.code, skuIsBase: false,
      price, compareAt, promo: promoRows.length > 0, lowest30: range(lows), lowestSource, storeName: u.location.store.name,
      omnibusFields: o?.found ?? [], historyComplete: complete,
      used: isReused((plinks ?? []).filter((p) => p.product_id === u.variant.product_id) as { store_id: string; tags?: string[] | null }[], storeId),
    };
  });
}
