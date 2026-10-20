import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { searchWords, wordsOr } from "@/lib/search";

/** Rozmiar do porównań: „EU 42,5” = „42.5”, bez spacji i wielkości liter. */
export function normOption(s: string | null | undefined) {
  return String(s ?? "").toLowerCase().replace(/^(eu|us|uk)\s*/, "").replace(/,/g, ".").replace(/\s+/g, "");
}

export type ShopifyMatch = { productId: string; title: string; image: string | null; sameSize: { id: string; option: string } | null; sizes: number };

/**
 * Produkty z katalogu Shopify podobne do rzeczy „nieprzypisanej” (po słowach z nazwy), w sklepie sztuki.
 * Najpierw wszystkie słowa naraz; brak wyników → coraz mniej słów (od początku nazwy, min. 2).
 */
export async function shopifyMatches(db: SupabaseClient, title: string, option: string, storeId: string, limit = 5): Promise<ShopifyMatch[]> {
  const words = searchWords(title, 8).filter((w) => w.length >= 2);
  if (!words.length) return [];
  for (let n = words.length; n >= Math.min(2, words.length); n--) {
    const filter = wordsOr(["title", "style_sku"], words.slice(0, n));
    const { data } = await db.from("products").select("id, title, image_url, variants(id, option)")
      .not("unassigned", "is", true).or(filter!).order("title").limit(20);
    const rows = (data ?? []) as { id: string; title: string; image_url: string | null; variants: { id: string; option: string }[] }[];
    if (!rows.length) continue;
    // Tylko produkty obecne w sklepie tej sztuki.
    const vids = rows.flatMap((r) => r.variants.map((v) => v.id));
    const { data: links } = await db.from("variant_store_links").select("variant_id").eq("store_id", storeId).in("variant_id", vids.slice(0, 500));
    const inStore = new Set((links ?? []).map((l) => l.variant_id as string));
    const out = rows
      .map((r) => {
        const vs = r.variants.filter((v) => inStore.has(v.id));
        const same = vs.find((v) => normOption(v.option) === normOption(option)) ?? null;
        return { productId: r.id, title: r.title, image: r.image_url, sameSize: same, sizes: vs.length };
      })
      .filter((m) => m.sizes > 0)
      .sort((a, b) => Number(!!b.sameSize) - Number(!!a.sameSize))
      .slice(0, limit);
    if (out.length) return out;
  }
  return [];
}

/** Słowa nazwy do porównań (małe litery, bez krótkich i znaków). */
function nameWords(s: string) {
  return [...new Set(s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter((w) => w.length >= 2))];
}

/** Czy nazwa produktu Shopify pasuje do rzeczy „nieprzypisanej” (min. 2 wspólne słowa i ≥ 60% słów krótszej nazwy). */
export function titlesMatch(a: string, b: string) {
  const wa = nameWords(a);
  const wb = new Set(nameWords(b));
  const common = wa.filter((w) => wb.has(w)).length;
  return common >= 2 && common >= 0.6 * Math.min(wa.length, wb.size);
}

export type UnassignedRef = { productId: string; title: string; options: Set<string> };

/** Rzeczy „nieprzypisane do Shopify” z aktywnymi sztukami (bez wycofanych i sprzedanych) – do podpowiedzi i ochrony przed duplikatem. */
export async function unassignedRefs(db: SupabaseClient): Promise<UnassignedRef[]> {
  const { data: prods, error } = await db.from("products").select("id, title, variants(id, option)").eq("unassigned", true).limit(500);
  if (error || !prods?.length) return [];
  const vids = prods.flatMap((p) => ((p.variants ?? []) as { id: string }[]).map((v) => v.id));
  const live = new Set<string>();
  for (let i = 0; i < vids.length; i += 200) {
    const { data } = await db.from("units").select("variant_id").in("variant_id", vids.slice(i, i + 200)).not("status", "in", "(removed,consignor_returned,sold)");
    for (const u of data ?? []) live.add(u.variant_id as string);
  }
  return prods.map((p) => ({
    productId: p.id as string, title: p.title as string,
    options: new Set(((p.variants ?? []) as { id: string; option: string }[]).filter((v) => live.has(v.id)).map((v) => normOption(v.option))),
  })).filter((r) => r.options.size);
}

/** Rozmiar ze Shopify, który pasuje do rzeczy nieprzypisanej (ta sama nazwa „mniej więcej” i rozmiar). */
export function matchesUnassigned(refs: UnassignedRef[], title: string, option: string) {
  const o = normOption(option);
  return refs.find((r) => r.options.has(o) && titlesMatch(r.title, title)) ?? null;
}

export type UnassignedGroup = {
  productId: string; title: string; storeId: string | null; storeName: string | null;
  units: { id: string; code: string; option: string; status: string; contract: string | null; supplier: string | null }[];
};

/** Rzeczy „nieprzypisane do Shopify” (bez wycofanych i sprzedanych) pogrupowane po produkcie – lista w Do zrobienia. */
export async function unassignedGroups(db: SupabaseClient, limit = 60): Promise<UnassignedGroup[]> {
  const { data: prods, error } = await db.from("products").select("id, title, variants(id, option)").eq("unassigned", true).order("created_at", { ascending: false }).limit(500);
  if (error || !prods?.length) return [];
  const optOf = new Map<string, { productId: string; option: string }>();
  for (const p of prods) for (const v of (p.variants ?? []) as { id: string; option: string }[]) optOf.set(v.id, { productId: p.id as string, option: v.option });
  const vids = [...optOf.keys()];
  const units: { id: string; code: string; status: string; variant_id: string; location: { store_id: string; store: { name: string } | null } | null; contract: { number: number | null; doc_number: string | null; counterparty: string | null; seller_name: string | null } | null; supplier?: string | null }[] = [];
  for (let i = 0; i < vids.length; i += 200) {
    const { data } = await db.from("units").select("*, location:locations(store_id, store:stores(name)), contract:contracts(number, doc_number, counterparty, seller_name)")
      .in("variant_id", vids.slice(i, i + 200)).not("status", "in", "(removed,consignor_returned,sold)").order("number");
    units.push(...((data ?? []) as unknown as typeof units));
  }
  const groups = new Map<string, UnassignedGroup>();
  for (const u of units) {
    const v = optOf.get(u.variant_id)!;
    const p = prods.find((x) => x.id === v.productId)!;
    const g = groups.get(v.productId) ?? { productId: v.productId, title: p.title as string, storeId: u.location?.store_id ?? null, storeName: u.location?.store?.name ?? null, units: [] };
    const c = u.contract;
    g.units.push({
      id: u.id, code: u.code, option: v.option, status: u.status,
      contract: c ? (c.doc_number ?? (c.number ? `NR${c.number}` : null)) : null,
      supplier: u.supplier ?? (c ? c.seller_name ?? c.counterparty : null),
    });
    groups.set(v.productId, g);
  }
  return [...groups.values()].slice(0, limit);
}

/** Liczba sztuk „nieprzypisanych do Shopify” (bez wycofanych i sprzedanych) – plakietka przy Do zrobienia. */
export async function unassignedUnitCount(db: SupabaseClient) {
  const { data: prods, error } = await db.from("products").select("variants(id)").eq("unassigned", true).limit(1000);
  if (error || !prods?.length) return 0;
  const vids = prods.flatMap((p) => ((p.variants ?? []) as { id: string }[]).map((v) => v.id));
  let n = 0;
  for (let i = 0; i < vids.length; i += 200) {
    const { count } = await db.from("units").select("id", { count: "exact", head: true }).in("variant_id", vids.slice(i, i + 200)).not("status", "in", "(removed,consignor_returned,sold)");
    n += count ?? 0;
  }
  return n;
}
