"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin, requireProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { importCatalogPage, type Store } from "@/lib/sync/catalog";
import { redirect } from "next/navigation";
import { errorMessage } from "@/lib/errors";

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

/** Czas startu importu wg zegara serwera (potrzebny do usunięcia produktów skasowanych w Shopify). */
export async function shopifyImportStart(): Promise<string> {
  await requireAdmin();
  return new Date().toISOString();
}

/** Po pełnym imporcie: produkty, których już nie ma w sklepie (albo są wykluczone), znikają z katalogu. */
export async function shopifyImportFinish(storeId: string, startedAt: string): Promise<Result<{ removed_links: number; removed_products: number }>> {
  await requireAdmin();
  try {
    const { data, error } = await createAdminClient().rpc("prune_store_catalog", { p_store_id: storeId, p_started_at: startedAt });
    if (error) throw error;
    revalidatePath("/katalog");
    return { ok: true, data };
  } catch (e) {
    return fail(e);
  }
}


/* ---------- Własne produkty (spoza Shopify, np. usługa „Renowacja obuwia”) ---------- */

const back = (msg: string, ok = true): never => redirect(`/katalog?widok=wlasne&${ok ? "ok" : "blad"}=${encodeURIComponent(msg)}`);
const money = (v: FormDataEntryValue | null) => {
  const t = String(v ?? "").replace(/\s/g, "").replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : NaN;
};

/** „Dodaj produkt” / zmiana: nazwa, cena, stawka PTU, opcjonalnie liczony stan i własny kod. */
export async function saveOwnProduct(fd: FormData) {
  const { supabase } = await requireProfile();
  const id = String(fd.get("id") ?? "");
  const name = String(fd.get("name") ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  const price = money(fd.get("price"));
  const ptu = String(fd.get("ptu") ?? "");
  const track = fd.get("track_stock") === "1";
  const stock = Math.max(0, Math.floor(Number(fd.get("stock") ?? 0)) || 0);
  const code = String(fd.get("code") ?? "").trim().toUpperCase().slice(0, 40) || null;
  if (!name) back("Podaj nazwę produktu.", false);
  if (Number.isNaN(price)) back("Zła cena.", false);
  if (!/^[A-F]$/.test(ptu)) back("Wybierz stawkę PTU.", false);
  const row = { name, price, ptu, track_stock: track, stock: track ? stock : 0, code };
  const { error } = id ? await supabase.from("pos_products").update(row).eq("id", id) : await supabase.from("pos_products").insert(row);
  revalidatePath("/katalog");
  back(error ? (/pos_products/.test(error.message) ? "Uruchom migrację 0037 w Supabase." : errorMessage(error)) : id ? "Zapisano produkt." : `Dodano produkt „${name}” – znajdziesz go w Kasie po nazwie${code ? " albo kodzie" : ""}.`, !error);
}

export async function toggleOwnProduct(fd: FormData) {
  const { supabase } = await requireProfile();
  const active = fd.get("active") === "1";
  await supabase.from("pos_products").update({ active }).eq("id", String(fd.get("id") ?? ""));
  revalidatePath("/katalog");
  back(active ? "Produkt przywrócony do Kasy." : "Produkt ukryty w Kasie.");
}
