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
