import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Produkty oznaczone w Shopify jako używane (tag „reused”) – jak w Magazynie: liczy się sklep sztuki,
 * a gdy produkt nie jest w tym sklepie – którykolwiek sklep.
 */
export async function reusedProducts(db: SupabaseClient, productIds: string[]) {
  const ids = [...new Set(productIds.filter(Boolean))];
  const links: { product_id: string; store_id: string; tags: string[] | null }[] = [];
  const parts = await Promise.all(Array.from({ length: Math.ceil(ids.length / 200) }, (_, i) =>
    db.from("product_store_links").select("product_id, store_id, tags").in("product_id", ids.slice(i * 200, i * 200 + 200))));
  for (const { data } of parts) links.push(...((data ?? []) as typeof links));
  const isReused = (l: { tags: string[] | null }) => (l.tags ?? []).some((t) => t.trim().toLowerCase() === "reused");
  /** Czy produkt jest używany (w danym sklepie, jeśli jest w nim w Shopify). */
  return (productId: string, storeId?: string | null) => {
    const all = links.filter((l) => l.product_id === productId);
    const mine = storeId ? all.filter((l) => l.store_id === storeId) : [];
    return (mine.length ? mine : all).some(isReused);
  };
}
