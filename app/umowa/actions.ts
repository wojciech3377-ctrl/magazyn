"use server";

import { createAdminClient } from "@/lib/supabase/admin";

export type CatalogHit = { productId: string; title: string; image: string | null; variants: { id: string; option: string }[] };

async function linkActive(key: string) {
  const db = createAdminClient();
  const { data } = await db.from("app_settings").select("value").eq("key", "general_contract_link").maybeSingle();
  const cfg = data?.value as { key?: string; enabled?: boolean } | undefined;
  return cfg?.enabled && cfg.key === key ? db : null;
}

/** Wyszukiwarka modeli z katalogu dla klienta z ogólnego linku (tylko nazwa, zdjęcie i rozmiary). */
export async function searchCatalogPublic(key: string, q: string): Promise<CatalogHit[]> {
  const db = await linkActive(key);
  const text = q.trim().replace(/[,()*%\\]/g, " ").trim().slice(0, 60);
  if (!db || text.length < 2) return [];
  const words = text.split(/\s+/).filter(Boolean).slice(0, 4);
  let query = db.from("products").select("id, title, style_sku, image_url, variants(id, option, position)").limit(8);
  for (const w of words) query = query.ilike("title", `%${w}%`);
  const { data } = await query;
  let rows = data ?? [];
  if (!rows.length) {
    const { data: bySku } = await db.from("products").select("id, title, style_sku, image_url, variants(id, option, position)").ilike("style_sku", `%${text}%`).limit(8);
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
