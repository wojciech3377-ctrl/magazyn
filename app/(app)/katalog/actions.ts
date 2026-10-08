"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin, requireProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { importCatalogPage, type Store } from "@/lib/sync/catalog";
import { baseCatalogChunk, startBaseCatalogSync } from "@/lib/sync/base-catalog";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

function fail(e: unknown): { ok: false; error: string } {
  return { ok: false, error: e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e) };
}

async function getStore(storeId: string) {
  const db = createAdminClient();
  const { data, error } = await db.from("stores").select("*").eq("id", storeId).single();
  if (error) throw error;
  return { db, store: data as Store };
}

export async function importShopifyPage(storeId: string, cursor: string | null): Promise<Result<{ next: string | null; products: number; created: number; variants: number }>> {
  await requireAdmin();
  try {
    const { db, store } = await getStore(storeId);
    return { ok: true, data: await importCatalogPage(db, store, cursor) };
  } catch (e) {
    return fail(e);
  }
}

export async function baseSyncStart(inventoryId: number): Promise<Result<{ total: number }>> {
  await requireAdmin();
  try {
    return { ok: true, data: await startBaseCatalogSync(createAdminClient(), inventoryId) };
  } catch (e) {
    return fail(e);
  }
}

export async function baseSyncChunk(inventoryId: number): Promise<Result<{ done: boolean; processed: number; total: number }>> {
  await requireAdmin();
  try {
    return { ok: true, data: await baseCatalogChunk(createAdminClient(), inventoryId) };
  } catch (e) {
    return fail(e);
  }
}

export async function applyLinks(storeId: string): Promise<Result<{ linked: number; suggested: number; missing: number; base_storage_id: string | null }>> {
  await requireAdmin();
  try {
    const db = createAdminClient();
    const { data, error } = await db.rpc("apply_base_links", { p_store_id: storeId });
    if (error) throw error;
    revalidatePath("/katalog");
    return { ok: true, data };
  } catch (e) {
    return fail(e);
  }
}

/** Zatwierdzenie podpowiedzi albo ręczne przypisanie (ID lub SKU z Base). */
export async function setLink(formData: FormData) {
  const { supabase } = await requireProfile();
  const linkId = String(formData.get("link_id"));
  const raw = String(formData.get("base") ?? "").trim();
  let baseId: number | null = null;
  if (raw) {
    // Najpierw SKU z Base (u Ciebie zwykle numer nadawany po kolei), potem ID produktu w Base.
    const { data: link } = await supabase.from("variant_store_links").select("store:stores(base_inventory_id)").eq("id", linkId).single();
    const inv = (link?.store as unknown as { base_inventory_id: number } | null)?.base_inventory_id ?? -1;
    const { data: bySku } = await supabase.from("base_products").select("id").eq("inventory_id", inv).ilike("sku", raw.replace(/[%_]/g, "")).eq("has_variants", false).limit(2);
    if (bySku?.length === 1) baseId = Number(bySku[0].id);
    else if (/^\d+$/.test(raw)) baseId = Number(raw);
    else {
      await supabase.from("sync_log").insert({ job: "manual-link", ok: false, message: `SKU ${raw}: ${bySku?.length ? "pasuje do kilku produktów w Base" : "nie ma go w katalogu Base"}` });
      revalidatePath("/katalog");
      return;
    }
  }
  if (formData.get("accept")) {
    const { data } = await supabase.from("variant_store_links").select("suggested_base_product_id").eq("id", linkId).single();
    baseId = data?.suggested_base_product_id ?? null;
  }
  const { error } = await supabase.rpc("set_base_link", { p_link_id: linkId, p_base_product_id: baseId });
  if (error) await supabase.from("sync_log").insert({ job: "manual-link", ok: false, message: error.message });
  revalidatePath("/katalog");
}

/** Zatwierdzenie wszystkich podpowiedzi na raz. */
export async function acceptAllSuggestions(formData: FormData) {
  const { supabase } = await requireAdmin();
  const storeId = String(formData.get("store_id"));
  const { data } = await supabase.from("variant_store_links").select("id, suggested_base_product_id")
    .eq("store_id", storeId).is("base_product_id", null).not("suggested_base_product_id", "is", null).limit(1000);
  for (const l of data ?? []) {
    await supabase.rpc("set_base_link", { p_link_id: l.id, p_base_product_id: l.suggested_base_product_id });
  }
  revalidatePath("/katalog");
}
