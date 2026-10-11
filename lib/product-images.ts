import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { productMedia } from "@/lib/integrations/shopify";

export type ProductImage = { url: string; alt: string | null; w: number | null; h: number | null };

/**
 * Wszystkie zdjęcia produktu ze Shopify (najpierw ze sklepu sztuki). Zapamiętane przy produkcie i odświeżane
 * najwyżej raz na dobę – przy otwarciu karty sztuki.
 */
export async function productImages(db: SupabaseClient, productId: string, storeId: string, fallback: string | null): Promise<ProductImage[]> {
  const { data: links } = await db.from("product_store_links").select("id, store_id, shopify_product_id, images, images_at, store:stores(code, shopify_domain)").eq("product_id", productId);
  type L = { id: string; store_id: string; shopify_product_id: string; images: ProductImage[] | null; images_at: string | null; store: { code: string; shopify_domain: string | null } | null };
  const list = ((links ?? []) as unknown as L[]).sort((a, b) => Number(b.store_id === storeId) - Number(a.store_id === storeId));
  const link = list.find((l) => l.store?.shopify_domain);
  if (!link) return fallback ? [{ url: fallback, alt: null, w: null, h: null }] : [];
  const fresh = link.images_at && Date.now() - new Date(link.images_at).getTime() < 24 * 3600_000;
  if (fresh && link.images?.length) return link.images;
  try {
    const images = await productMedia(link.store!.shopify_domain!, link.store!.code, link.shopify_product_id);
    await db.from("product_store_links").update({ images, images_at: new Date().toISOString() }).eq("id", link.id);
    if (images.length) return images;
  } catch {
    if (link.images?.length) return link.images;
  }
  return fallback ? [{ url: fallback, alt: null, w: null, h: null }] : [];
}
