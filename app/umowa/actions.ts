"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { clientIp, rateLimit, safeEqual } from "@/lib/security";

export type CatalogHit = { productId: string; title: string; image: string | null; variants: { id: string; option: string }[] };

async function linkActive(key: string) {
  const db = createAdminClient();
  const { data } = await db.from("app_settings").select("value").eq("key", "general_contract_link").maybeSingle();
  const cfg = data?.value as { key?: string; enabled?: boolean } | undefined;
  return cfg?.enabled && safeEqual(cfg.key, key) ? db : null;
}

/** Wyszukiwarka modeli z katalogu dla klienta z ogólnego linku (tylko nazwa, zdjęcie i rozmiary). */
export async function searchCatalogPublic(key: string, q: string, storeId?: string): Promise<CatalogHit[]> {
  if (!(await rateLimit(`public-search:${await clientIp()}`, 120, 5 * 60))) return [];
  const db = await linkActive(key);
  const text = q.trim().replace(/[,()*%\\]/g, " ").trim().slice(0, 60);
  if (!db || text.length < 2) return [];
  // Tylko produkty wybranego sklepu.
  const inStore = !!storeId && /^[0-9a-f-]{36}$/.test(storeId);
  const words = text.split(/\s+/).filter(Boolean).slice(0, 4);
  let query = db.from("products").select("id, title, style_sku, image_url, variants(id, option, position), links:product_store_links!inner(store_id)").limit(8);
  if (inStore) query = query.eq("links.store_id", storeId!);
  for (const w of words) query = query.ilike("title", `%${w}%`);
  const { data } = await query;
  let rows = data ?? [];
  if (!rows.length) {
    let q2 = db.from("products").select("id, title, style_sku, image_url, variants(id, option, position), links:product_store_links!inner(store_id)").ilike("style_sku", `%${text}%`).limit(8);
    if (inStore) q2 = q2.eq("links.store_id", storeId!);
    const { data: bySku } = await q2;
    rows = bySku ?? [];
  }
  const collator = new Intl.Collator("pl", { numeric: true });
  return rows.map((p) => ({
    productId: p.id as string,
    title: p.title as string,
    image: (p.image_url as string | null) ?? null,
    variants: ((p.variants ?? []) as { id: string; option: string }[])
      .map((v) => ({ id: v.id, option: v.option }))
      .sort((a, b) => collator.compare(a.option, b.option)),
  }));
}
