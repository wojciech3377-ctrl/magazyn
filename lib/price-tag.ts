import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { omnibusMetafields } from "@/lib/integrations/shopify";

/**
 * Metka sklepowa: cena modelu (zakres po wszystkich rozmiarach w sklepie), promocja (cena przed obniżką)
 * i najniższa cena z 30 dni przed obniżką (Omnibus): z metapola aplikacji Omnibus w Shopify, a gdy go nie ma –
 * z historii cen zapisywanej przez aplikację.
 */

export type Range = { min: number; max: number } | null;
export type PriceTag = {
  unitId: string; code: string; title: string; option: string; sku: string; skuIsBase: boolean;
  price: Range; compareAt: Range; promo: boolean; lowest30: Range; lowestSource: string; storeName: string;
};

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
function lowestFromHistory(rows: Hist[], current: number, now = Date.now()) {
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
    .select("id, code, variant_id, variant:variants(option, product_id, product:products(title)), location:locations(store_id, store:stores(name, code, shopify_domain))")
    .in("id", unitIds.slice(0, 200)).order("number");
  type U = { id: string; code: string; variant_id: string; variant: { option: string; product_id: string; product: { title: string } }; location: { store_id: string; store: { name: string; code: string; shopify_domain: string | null } } };
  const list = (units ?? []) as unknown as U[];
  const productIds = [...new Set(list.map((u) => u.variant.product_id))];
  const { data: variants } = productIds.length ? await db.from("variants").select("id, product_id").in("product_id", productIds) : { data: [] };
  const variantIds = (variants ?? []).map((v) => v.id as string);
  const byProduct = new Map<string, string[]>();
  for (const v of variants ?? []) byProduct.set(v.product_id as string, [...(byProduct.get(v.product_id as string) ?? []), v.id as string]);
  const since = new Date(Date.now() - 120 * 86400_000).toISOString();
  const [{ data: links }, { data: hist }, { data: plinks }] = await Promise.all([
    variantIds.length ? db.from("variant_store_links").select("variant_id, store_id, price, compare_at_price, base_sku, shopify_variant_id").in("variant_id", variantIds) : Promise.resolve({ data: [] }),
    variantIds.length ? db.from("variant_price_history").select("variant_id, store_id, price, valid_from").in("variant_id", variantIds).gte("valid_from", since).order("valid_from") : Promise.resolve({ data: [] }),
    productIds.length ? db.from("product_store_links").select("product_id, store_id, shopify_product_id").in("product_id", productIds) : Promise.resolve({ data: [] }),
  ]);
  type L = { variant_id: string; store_id: string; price: number | null; compare_at_price: number | null; base_sku: string | null; shopify_variant_id: string | null };
  const linkRows = (links ?? []) as L[];

  // Metapola Omnibus ze Shopify (raz na produkt i sklep).
  const omni = new Map<string, { product: number | null; variants: Map<string, number>; found: string[] }>();
  for (const key of [...new Set(list.map((u) => `${u.variant.product_id}|${u.location.store_id}`))].slice(0, 30)) {
    const [pid, sid] = key.split("|");
    const u = list.find((x) => x.variant.product_id === pid && x.location.store_id === sid)!;
    const gid = (plinks ?? []).find((p) => p.product_id === pid && p.store_id === sid)?.shopify_product_id as string | undefined;
    if (!gid || !u.location.store.shopify_domain) continue;
    try {
      const mf = await omnibusMetafields(u.location.store.shopify_domain, u.location.store.code, gid);
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

  return list.map((u): PriceTag & { omnibusFields: string[]; historyComplete: boolean } => {
    const storeId = u.location.store_id;
    const vids = byProduct.get(u.variant.product_id) ?? [u.variant_id];
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
      const r = lowestFromHistory(((hist ?? []) as (Hist & { store_id: string })[]).filter((h) => h.variant_id === l.variant_id && h.store_id === storeId), Number(l.price));
      if (!r.complete) complete = false;
      return r.value ?? Number(l.price);
    });
    const own = linkRows.find((l) => l.variant_id === u.variant_id && l.store_id === storeId && l.base_sku)?.base_sku ?? linkRows.find((l) => l.variant_id === u.variant_id && l.base_sku)?.base_sku ?? null;
    return {
      unitId: u.id, code: u.code, title: u.variant.product.title, option: u.variant.option, sku: own ?? u.code, skuIsBase: !!own,
      price, compareAt, promo: promoRows.length > 0, lowest30: range(lows), lowestSource, storeName: u.location.store.name,
      omnibusFields: o?.found ?? [], historyComplete: complete,
    };
  });
}
