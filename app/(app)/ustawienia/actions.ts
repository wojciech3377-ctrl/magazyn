"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { registerProductWebhooks } from "@/lib/integrations/shopify";

function done(msg: string, tone: "ok" | "blad" = "ok"): never {
  revalidatePath("/ustawienia");
  redirect(`/ustawienia?${tone}=${encodeURIComponent(msg)}`);
}

function num(v: FormDataEntryValue | null) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) done(`„${s}” to nie jest poprawne ID (same cyfry).`, "blad");
  return Number(s);
}

export async function saveStore(formData: FormData) {
  const { supabase } = await requireAdmin();
  const domain = String(formData.get("shopify_domain") ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (domain && !/^[a-z0-9-]+\.myshopify\.com$/.test(domain)) done("Domena Shopify musi mieć postać nazwa.myshopify.com", "blad");
  const { error } = await supabase.from("stores").update({
    shopify_domain: domain || null,
    base_inventory_id: num(formData.get("base_inventory_id")),
    base_order_source_id: num(formData.get("base_order_source_id")),
    base_storage_id: String(formData.get("base_storage_id") ?? "").trim() || null,
  }).eq("id", String(formData.get("id")));
  if (error) done(error.message, "blad");
  done("Sklep zapisany.");
}

export async function saveLocation(formData: FormData) {
  const { supabase } = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const row = {
    store_id: String(formData.get("store_id")),
    name: String(formData.get("name") ?? "").trim(),
    base_warehouse_id: String(formData.get("base_warehouse_id") ?? "").trim() || null,
    active: formData.get("active") !== null || !id,
  };
  if (!row.name) done("Podaj nazwę lokalizacji.", "blad");
  const { error } = id ? await supabase.from("locations").update(row).eq("id", id) : await supabase.from("locations").insert(row);
  if (error) done(error.message, "blad");
  done("Lokalizacja zapisana.");
}

export async function registerWebhooks(formData: FormData) {
  const { supabase } = await requireAdmin();
  const { data: store } = await supabase.from("stores").select("*").eq("id", String(formData.get("id"))).single();
  if (!store?.shopify_domain) done("Najpierw ustaw domenę Shopify.", "blad");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host || host.startsWith("localhost")) done("Webhooki rejestruj z opublikowanej aplikacji (adres https), nie lokalnie.", "blad");
  try {
    const r = await registerProductWebhooks(store.shopify_domain, store.code, `https://${host}/api/shopify/webhook/${store.code}`);
    done(`${store.name}: ${r.join(", ")}`);
  } catch (e) {
    unstable_rethrow(e);
    done(e instanceof Error ? e.message : String(e), "blad");
  }
}

export async function importInitialStock() {
  const { supabase } = await requireAdmin();
  const { data, error } = await supabase.rpc("import_initial_stock");
  if (error) done(error.message, "blad");
  done(`Wgrano ${data.units} sztuk (${data.variants} pozycji) jako „bez umowy”.`);
}

export async function saveUser(formData: FormData) {
  const { supabase, profile } = await requireAdmin();
  const id = String(formData.get("id"));
  const patch = {
    full_name: String(formData.get("full_name") ?? "").trim() || null,
    role: String(formData.get("role")) === "admin" ? "admin" : "staff",
    can_see_prices: formData.get("can_see_prices") !== null,
    active: formData.get("active") !== null,
  };
  if (id === profile.id && (patch.role !== "admin" || !patch.active)) done("Nie możesz odebrać sobie uprawnień administratora.", "blad");
  const { error } = await supabase.from("profiles").update(patch).eq("id", id);
  if (error) done(error.message, "blad");
  done("Użytkownik zapisany.");
}

/** Nowe konto z hasłem startowym (bez wysyłania e-maili). */
export async function createUser(formData: FormData) {
  await requireAdmin();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (!email || password.length < 10) done("Podaj e-mail i hasło startowe (min. 10 znaków).", "blad");
  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) done(error.message, "blad");
  // Konto dodane przez administratora od razu aktywne (samodzielne rejestracje zostają nieaktywne).
  await admin.from("profiles").update({ active: true }).eq("id", data.user.id);
  done(`Konto ${email} utworzone. Przekaż hasło osobiście i poproś o zmianę po pierwszym logowaniu.`);
}

export async function addExclusion(formData: FormData) {
  const { supabase } = await requireAdmin();
  const kind = String(formData.get("kind")) === "title_contains" ? "title_contains" : "sku_prefix";
  const value = String(formData.get("value") ?? "").trim();
  if (value.length < 2) done("Wpisz co najmniej 2 znaki.", "blad");
  const { error } = await supabase.from("catalog_exclusions").insert({ kind, value });
  if (error) done(error.message, "blad");
  done(`Dodano wykluczenie „${value}”. Kliknij „Usuń wykluczone z magazynu”, żeby usunąć już wgrane produkty.`);
}

export async function deleteExclusion(formData: FormData) {
  const { supabase } = await requireAdmin();
  const { error } = await supabase.from("catalog_exclusions").delete().eq("id", String(formData.get("id")));
  if (error) done(error.message, "blad");
  done("Wykluczenie usunięte. Produkty wrócą przy następnym imporcie z Shopify.");
}

export async function purgeExcluded() {
  const { supabase } = await requireAdmin();
  const { data, error } = await supabase.rpc("purge_excluded");
  if (error) done(error.message, "blad");
  done(`Usunięto z magazynu ${data.variants ?? 0} rozmiarów/wariantów (${data.products} całych produktów) i ${data.units} sztuk. Stany w Base bez zmian.`);
}

export async function saveCompany(formData: FormData) {
  const { supabase } = await requireAdmin();
  const value = {
    name: String(formData.get("name") ?? "").trim(),
    street: String(formData.get("street") ?? "").trim(),
    city: String(formData.get("city") ?? "").trim(),
    nip: String(formData.get("nip") ?? "").replace(/[^0-9]/g, ""),
    email: String(formData.get("email") ?? "").trim(),
    payment_days: Math.max(0, Math.min(60, Number(formData.get("payment_days") ?? 7) || 7)),
  };
  if (!value.name || !value.street || !value.city || value.nip.length !== 10) done("Uzupełnij nazwę, adres i NIP (10 cyfr).", "blad");
  const { error } = await supabase.from("app_settings").upsert({ key: "company", value, updated_at: new Date().toISOString() });
  if (error) done(error.message, "blad");
  done("Dane firmy zapisane – będą na nowych umowach.");
}

export async function saveBuyerSignature(formData: FormData) {
  const { supabase } = await requireAdmin();
  const image = String(formData.get("signature") ?? "");
  const { validateSignaturePng } = await import("@/lib/contracts/png");
  const err = validateSignaturePng(image);
  if (err) done(err, "blad");
  const { error } = await supabase.from("app_settings").upsert({ key: "buyer_signature", value: { image }, updated_at: new Date().toISOString() });
  if (error) done(error.message, "blad");
  done("Podpis kupującego zapisany.");
}

export async function updateGeneralLink(formData: FormData) {
  const { supabase } = await requireAdmin();
  const { data } = await supabase.from("app_settings").select("value").eq("key", "general_contract_link").maybeSingle();
  const cur = (data?.value ?? {}) as { key?: string; enabled?: boolean };
  const op = String(formData.get("op"));
  const value = {
    key: op === "regenerate" || !cur.key ? crypto.randomUUID().replace(/-/g, "") : cur.key,
    enabled: op === "disable" ? false : op === "enable" ? true : cur.enabled ?? true,
  };
  const { error } = await supabase.from("app_settings").upsert({ key: "general_contract_link", value, updated_at: new Date().toISOString() });
  if (error) done(error.message, "blad");
  done(op === "regenerate" ? "Nowy link utworzony – stary przestał działać." : "Zapisano.");
}
