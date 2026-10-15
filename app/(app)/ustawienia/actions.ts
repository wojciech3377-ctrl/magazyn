"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import { forgetProfile, requireAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { deleteWebhooks, listWebhooks, registerProductWebhooks } from "@/lib/integrations/shopify";
import { disconnect } from "@/lib/integrations/furgonetka";
import { errorMessage } from "@/lib/errors";

async function done(msg: string, tone: "ok" | "blad" = "ok"): Promise<never> {
  revalidatePath("/ustawienia");
  // Powrót na tę samą zakładkę ustawień, z której przyszło żądanie.
  const ref = (await headers()).get("referer") ?? "";
  const tab = ref.match(/[?&]zakladka=([a-z]+)/)?.[1];
  redirect(`/ustawienia?${tab ? `zakladka=${tab}&` : ""}${tone}=${encodeURIComponent(msg)}`);
}

/** ID z formularza: liczba, null (puste) albo false (błędne). */
function num(v: FormDataEntryValue | null): number | null | false {
  const s = String(v ?? "").trim();
  if (!s) return null;
  return /^\d+$/.test(s) ? Number(s) : false;
}

export async function saveStore(formData: FormData) {
  const { supabase } = await requireAdmin();
  const domain = String(formData.get("shopify_domain") ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (domain && !/^[a-z0-9-]+\.myshopify\.com$/.test(domain)) return done("Domena Shopify musi mieć postać nazwa.myshopify.com", "blad");
  const { error } = await supabase.from("stores").update({ shopify_domain: domain || null }).eq("id", String(formData.get("id")));
  if (error) return done(error.message, "blad");
  await done("Sklep zapisany.");
}

export async function saveLocation(formData: FormData) {
  const { supabase } = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const row = {
    store_id: String(formData.get("store_id")),
    name: String(formData.get("name") ?? "").trim(),
    active: formData.get("active") !== null || !id,
    ...(formData.has("ship_address") ? { ship_address: String(formData.get("ship_address") ?? "").trim().slice(0, 400) || null } : {}),
  };
  if (!row.name) return done("Podaj nazwę lokalizacji.", "blad");
  const { error } = id ? await supabase.from("locations").update(row).eq("id", id) : await supabase.from("locations").insert(row);
  if (error) return done(error.message, "blad");
  await done("Lokalizacja zapisana.");
}

/** Przełącznik „na żywo”: webhooki produktów, zamówień, zwrotów i stanów (włącz / wyłącz). */
export async function registerWebhooks(formData: FormData) {
  const { supabase } = await requireAdmin();
  const { data: store } = await supabase.from("stores").select("*").eq("id", String(formData.get("id"))).single();
  if (!store?.shopify_domain) return done("Najpierw ustaw domenę Shopify.", "blad");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host || host.startsWith("localhost")) return done("Webhooki rejestruj z opublikowanej aplikacji (adres https), nie lokalnie.", "blad");
  const turnOn = String(formData.get("live") ?? "1") === "1";
  try {
    if (turnOn) {
      const r = await registerProductWebhooks(store.shopify_domain, store.code, `https://${host}/api/shopify/webhook/${store.code}`);
      const failed = r.filter((x) => !/: (ok|już włączony)$/.test(x));
      await done(failed.length ? `${store.name}: włączone częściowo – ${failed.join(", ")}` : `${store.name}: na żywo włączone (produkty, zamówienia, zwroty, stany).`, failed.length ? "blad" : "ok");
    } else {
      const mine = await listWebhooks(store.shopify_domain, store.code, `/api/shopify/webhook/${store.code}`);
      const errors = await deleteWebhooks(store.shopify_domain, store.code, mine.map((w) => w.id));
      await done(errors.length ? `${store.name}: ${errors.join("; ")}` : `${store.name}: na żywo wyłączone – zmiany przyjdą przy odczycie co 15 min.`, errors.length ? "blad" : "ok");
    }
  } catch (e) {
    unstable_rethrow(e);
    await done(errorMessage(e), "blad");
  }
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
  if (id === profile.id && (patch.role !== "admin" || !patch.active)) return done("Nie możesz odebrać sobie uprawnień administratora.", "blad");
  const { error } = await supabase.from("profiles").update(patch).eq("id", id);
  forgetProfile();
  if (error) return done(error.message, "blad");
  await done("Użytkownik zapisany.");
}

/** Nowe konto z hasłem startowym (bez wysyłania e-maili). */
export async function createUser(formData: FormData) {
  await requireAdmin();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (!email || password.length < 10) return done("Podaj e-mail i hasło startowe (min. 10 znaków).", "blad");
  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) return done(error.message, "blad");
  // Konto dodane przez administratora od razu aktywne (samodzielne rejestracje zostają nieaktywne).
  await admin.from("profiles").update({ active: true }).eq("id", data.user.id);
  forgetProfile();
  await done(`Konto ${email} utworzone. Przekaż hasło osobiście i poproś o zmianę po pierwszym logowaniu.`);
}

export async function addExclusion(formData: FormData) {
  const { supabase } = await requireAdmin();
  const kind = String(formData.get("kind")) === "title_contains" ? "title_contains" : "sku_prefix";
  const value = String(formData.get("value") ?? "").trim();
  if (value.length < 2) return done("Wpisz co najmniej 2 znaki.", "blad");
  const vat = formData.get("vat") === "23" ? "23" : "margin";
  let { error } = await supabase.from("catalog_exclusions").insert({ kind, value, vat });
  if (error && /vat/.test(error.message)) ({ error } = await supabase.from("catalog_exclusions").insert({ kind, value }));
  if (error) return done(error.message, "blad");
  await done(`Dodano wykluczenie „${value}”. Kliknij „Usuń wykluczone z magazynu”, żeby usunąć już wgrane produkty.`);
}

/** Stawka na paragonie dla pozycji z tej reguły (np. rope → VAT marża, usługa → 23%). */
export async function setExclusionVat(formData: FormData) {
  const { supabase } = await requireAdmin();
  const vat = formData.get("vat") === "23" ? "23" : "margin";
  const { error } = await supabase.from("catalog_exclusions").update({ vat }).eq("id", String(formData.get("id")));
  if (error) return done(/vat/.test(error.message) ? "Uruchom migrację 0045_exclusion_vat.sql w Supabase." : error.message, "blad");
  await done(`Stawka na paragonie zapisana: ${vat === "23" ? "23%" : "VAT marża"}.`);
}

export async function deleteExclusion(formData: FormData) {
  const { supabase } = await requireAdmin();
  const { error } = await supabase.from("catalog_exclusions").delete().eq("id", String(formData.get("id")));
  if (error) return done(error.message, "blad");
  await done("Wykluczenie usunięte. Produkty wrócą przy następnym imporcie z Shopify.");
}

export async function purgeExcluded() {
  const { supabase } = await requireAdmin();
  const { data, error } = await supabase.rpc("purge_excluded");
  if (error) return done(error.message, "blad");
  await done(`Usunięto z magazynu ${data.variants ?? 0} rozmiarów/wariantów (${data.products} całych produktów) i ${data.units} sztuk. Stany w Shopify bez zmian.`);
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
    bank_account: String(formData.get("bank_account") ?? "").replace(/[^0-9A-Za-z]/g, "").slice(0, 34),
  };
  if (!value.name || !value.street || !value.city || value.nip.length !== 10) return done("Uzupełnij nazwę, adres i NIP (10 cyfr).", "blad");
  const { error } = await supabase.from("app_settings").upsert({ key: "company", value, updated_at: new Date().toISOString() });
  if (error) return done(error.message, "blad");
  await done("Dane firmy zapisane – będą na nowych umowach.");
}

export async function saveBuyerSignature(formData: FormData) {
  const { supabase } = await requireAdmin();
  const image = String(formData.get("signature") ?? "");
  const { validateSignaturePng } = await import("@/lib/contracts/png");
  const err = validateSignaturePng(image);
  if (err) return done(err, "blad");
  const { error } = await supabase.from("app_settings").upsert({ key: "buyer_signature", value: { image }, updated_at: new Date().toISOString() });
  if (error) return done(error.message, "blad");
  await done("Podpis kupującego zapisany.");
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
  if (error) return done(error.message, "blad");
  await done(op === "regenerate" ? "Nowy link utworzony – stary przestał działać." : "Zapisano.");
}

export async function saveSender(formData: FormData) {
  const { supabase } = await requireAdmin();
  const f = (k: string) => String(formData.get(k) ?? "").trim();
  const point = f("inpost_send_point").toUpperCase();
  const value = {
    company: f("company"),
    name: f("name"),
    street: f("street"),
    postcode: f("postcode"),
    city: f("city"),
    email: f("email"),
    phone: f("phone"),
    inpost_send_point: !point || point === "ANY_APM" ? "any_apm" : point,
    dpd_send_point: !f("dpd_send_point") || f("dpd_send_point").toLowerCase() === "any_parcel_shop" ? "any_parcel_shop" : f("dpd_send_point").toUpperCase(),
    cod_iban: f("cod_iban").replace(/\s/g, ""),
  };
  if (!value.street || !value.postcode || !value.city) return done("Podaj adres nadawcy.", "blad");
  if (!value.company && !value.name) return done("Podaj firmę albo imię i nazwisko nadawcy.", "blad");
  const { error } = await supabase.from("app_settings").upsert({ key: "shipping_sender", value, updated_at: new Date().toISOString() });
  if (error) return done(error.message, "blad");
  await done("Dane nadawcy zapisane.");
}

export async function disconnectFurgonetka() {
  await requireAdmin();
  await disconnect(createAdminClient());
  await done("Furgonetka odłączona.");
}

/** Główny magazyn: Shopify (stany ze sklepu → sztuki) albo aplikacja (sztuki → stany w Shopify). */
export async function saveStockMaster(formData: FormData) {
  const { supabase } = await requireAdmin();
  const master = String(formData.get("master")) === "app" ? "app" : "shopify";
  if (master === "app" && formData.get("confirm") !== "1") return done("Zaznacz potwierdzenie – stany w Shopify zostaną nadpisane stanem z aplikacji.", "blad");
  const { error } = await supabase.from("app_settings").upsert({ key: "stock", value: { master, changed_at: new Date().toISOString() }, updated_at: new Date().toISOString() });
  if (error) return done(error.message, "blad");
  await done(master === "app"
    ? "Główny jest magazyn aplikacji – przy najbliższym odczycie (co 15 min) stany w Shopify przyjmą liczbę sztuk z aplikacji."
    : "Główny jest Shopify – nowe stany ze sklepu tworzą sztuki w Magazynie.");
}

export async function saveShopifyLocation(formData: FormData) {
  const { supabase } = await requireAdmin();
  const value = String(formData.get("shopify_location_id") ?? "").trim();
  if (value && !/^gid:\/\/shopify\/Location\/\d+$/.test(value)) return done("Zła lokalizacja Shopify.", "blad");
  const { error } = await supabase.from("locations").update({ shopify_location_id: value || null }).eq("id", String(formData.get("id")));
  if (error) return done(error.message, "blad");
  await done("Lokalizacja Shopify zapisana.");
}

export async function runStockNow(formData: FormData) {
  await requireAdmin();
  const db = createAdminClient();
  const force = formData.get("force") === "1";
  if (force && formData.get("confirm") !== "1") return done("Zaznacz potwierdzenie – stan aplikacji zostanie wyrównany do Shopify.", "blad");
  try {
    const { syncStock } = await import("@/lib/sync/shopify-stock");
    const r = await syncStock(db, { force });
    await db.from("sync_log").insert({ job: "stock", ok: true, message: JSON.stringify(r) });
    const parts = Object.entries(r.result as Record<string, unknown>).map(([store, x]) => {
      const v = x as { created?: number; removed?: number; withdrawn?: number; waiting?: number; kept?: number } | string;
      return typeof v === "string" ? `${store}: ${v}` : `${store}: dodano ${v.created ?? 0}, usunięto ${v.removed ?? 0}${v.withdrawn ? `, wycofano (z historią) ${v.withdrawn}` : ""}${v.waiting ? `, czeka na potwierdzenie ${v.waiting}` : ""}${v.kept ? `, zostaje ${v.kept} (komis albo reszta przy kolejnym odczycie)` : ""}`;
    });
    await done(`Stany sprawdzone. ${parts.join(" · ")}`);
  } catch (e) {
    unstable_rethrow(e);
    await db.from("sync_log").insert({ job: "stock", ok: false, message: errorMessage(e) });
    await done(errorMessage(e), "blad");
  }
}

/** Ustawienia → Stany → „Sprawdź produkt” → „Wyrównaj te produkty teraz”. */
export async function fixProductStockNow(formData: FormData) {
  await requireAdmin();
  const text = String(formData.get("sprawdz") ?? "").trim().slice(0, 100);
  const back = (msg: string, tone: "ok" | "blad") => {
    revalidatePath("/ustawienia");
    redirect(`/ustawienia?zakladka=stany&sprawdz=${encodeURIComponent(text)}&${tone}=${encodeURIComponent(msg)}#sprawdz`);
  };
  if (text.length < 2) back("Wpisz nazwę albo SKU produktu.", "blad");
  const db = createAdminClient();
  try {
    const { fixProductStock } = await import("@/lib/stock-diagnose");
    const r = await fixProductStock(db, text);
    const parts = r.totals.map((t) => `${t.store}: dodano ${t.added}, usunięto ${t.removed}`);
    await db.from("sync_log").insert({ job: "stock", ok: !r.errors.length, message: `Wyrównanie „${text}”: ${JSON.stringify(r)}` });
    if (r.errors.length) back(r.errors.join(" · "), "blad");
    back(`Wyrównano ze Shopify.${r.split ? ` Rozdzielono ${r.split} połączonych produktów.` : ""} ${parts.join(" · ") || "Bez zmian."}`, "ok");
  } catch (e) {
    unstable_rethrow(e);
    back(errorMessage(e), "blad");
  }
}

export async function saveInvoiceSettings(formData: FormData) {
  const { supabase } = await requireAdmin();
  const { error } = await supabase.from("app_settings").upsert({ key: "invoices", value: { auto_email: formData.get("auto_email") === "1" }, updated_at: new Date().toISOString() });
  if (error) return done(error.message, "blad");
  await done("Ustawienia faktur zapisane.");
}

/** Usunięcie z magazynu produktów spoza Shopify (sztuki bez historii; komis, umowy i sprzedaż zostają). */
export async function purgeNonShopify(formData: FormData) {
  await requireAdmin();
  if (formData.get("confirm") !== "1") return done("Zaznacz potwierdzenie usunięcia.", "blad");
  const { data, error } = await (await import("@/lib/supabase/admin")).createAdminClient().rpc("purge_non_shopify", { p_dry_run: false });
  if (error) return done(error.message, "blad");
  const r = data as { units: number; kept: number; variants: number; products: number };
  await done(`Usunięto ${r.units} sztuk, ${r.variants} rozmiarów i ${r.products} produktów spoza Shopify.${r.kept ? ` Zostało ${r.kept} sztuk z historią (umowa, komis, sprzedaż) – przejrzyj je ręcznie.` : ""}`);
}

/** Wysyłka e-maili: serwer, login i nadawca w ustawieniach, hasło w Supabase Vault; zapis sprawdza logowanie. */
export async function saveSmtp(formData: FormData) {
  await requireAdmin();
  const db = createAdminClient();
  const f = (k: string) => String(formData.get(k) ?? "").trim();
  const host = f("host").toLowerCase();
  const port = Number(f("port") || 465);
  const user = f("user");
  const password = String(formData.get("password") ?? "");
  const fromEmail = f("from_email");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return done("Podaj serwer SMTP, np. ssl0.ovh.net.", "blad");
  if (![465, 587, 25, 2525].includes(port)) return done("Port SMTP: 465 (SSL) albo 587.", "blad");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(user)) return done("Login to pełny adres skrzynki.", "blad");
  if (fromEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(fromEmail)) return done("Zły adres nadawcy.", "blad");
  const { data: hasPass } = await db.rpc("smtp_password_exists");
  if (!password && !hasPass) return done("Wpisz hasło skrzynki.", "blad");

  // Najpierw sprawdzenie logowania – zapisujemy tylko działające ustawienia.
  let pass = password;
  if (!pass) {
    const { data } = await db.rpc("smtp_password_get");
    pass = (data as string | null) ?? "";
  }
  try {
    const nodemailer = (await import("nodemailer")).default;
    await nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } }).verify();
  } catch (e) {
    return done(`Serwer poczty odrzucił logowanie: ${errorMessage(e)}. Sprawdź login (pełny adres) i hasło skrzynki.`, "blad");
  }
  if (password) {
    const { error } = await db.rpc("smtp_password_set", { p_password: password });
    if (error) return done(`Nie udało się zapisać hasła w sejfie: ${error.message}`, "blad");
  }
  const { error } = await db.from("app_settings").upsert({
    key: "smtp", value: { host, port, user, from_email: fromEmail || null, from_name: f("from_name") || null }, updated_at: new Date().toISOString(),
  });
  if (error) return done(error.message, "blad");
  const { clearMailCache } = await import("@/lib/mail");
  clearMailCache();
  await done(`Wysyłka e-maili ustawiona – maile wychodzą z ${fromEmail || user}.`);
}

/** Sprawdzenie, czy aplikacja widzi najniższą cenę z 30 dni (metapole „Lowest price” z Omnibus Insight). */
export async function checkOmnibus() {
  const { supabase } = await requireAdmin();
  const { lowestPriceDefinitions, readMetafields, omnibusMetafields } = await import("@/lib/integrations/shopify");
  const { data: stores } = await supabase.from("stores").select("id, name, code, shopify_domain").not("shopify_domain", "is", null);
  const out: string[] = [];
  for (const st of stores ?? []) {
    try {
      const defs = await lowestPriceDefinitions(st.shopify_domain as string, st.code as string);
      const names = [...defs.product.map((d) => `${d.name} (${d.namespace}.${d.key}, produkt)`), ...defs.variant.map((d) => `${d.name} (${d.namespace}.${d.key}, rozmiar)`)];
      const { data: pl } = await supabase.from("product_store_links").select("shopify_product_id").eq("store_id", st.id).eq("status", "ACTIVE").order("updated_at", { ascending: false }).limit(1).maybeSingle();
      let sample = "";
      if (pl) {
        const [named, heur] = await Promise.all([
          readMetafields(st.shopify_domain as string, st.code as string, pl.shopify_product_id as string, defs),
          omnibusMetafields(st.shopify_domain as string, st.code as string, pl.shopify_product_id as string),
        ]);
        const all = [...named.product, ...[...named.variants.values()].flat(), ...heur.product, ...[...heur.variants.values()].flat()];
        sample = all.length ? ` Próbka: ${all.slice(0, 2).map((m) => `${m.namespace}.${m.key} = ${String(m.value).slice(0, 60)}`).join("; ")}.` : " Próbny produkt nie ma wartości tego metapola.";
      }
      out.push(names.length
        ? `${st.name}: widzę ${names.join(", ")}.${sample}`
        : `${st.name}: nie widzę metapola „Lowest price” – jest prywatne aplikacji Omnibus Insight. Metka bierze cenę ze strony produktu (blok Omnibus), a gdy go nie ma – z historii cen aplikacji (pełna po 30 dniach od jej startu).`);
    } catch (e) {
      out.push(`${st.name}: ${errorMessage(e)}`);
    }
  }
  return done(out.join(" ") || "Brak sklepów Shopify.");
}

/** Sklep pokazywany domyślnie w Sprzedaż → Zamówienia. */
export async function saveOrdersDefaultStore(formData: FormData) {
  const { supabase } = await requireAdmin();
  const v = String(formData.get("default_store") ?? "");
  const { error } = await supabase.from("app_settings").upsert({ key: "orders", value: { default_store: v || "wszystkie" }, updated_at: new Date().toISOString() });
  if (error) return done(error.message, "blad");
  await done("Zapisano domyślny sklep w Zamówieniach.");
}

/** „Ukryj” błąd automatu – wróci, jeśli zniknie i pojawi się ponownie. */
export async function dismissIssue(formData: FormData) {
  await requireAdmin();
  const key = String(formData.get("key") ?? "").slice(0, 200);
  const back = String(formData.get("back") ?? "/ustawienia");
  if (key) await createAdminClient().from("app_issues").update({ dismissed_at: new Date().toISOString() }).eq("key", key);
  revalidatePath("/", "layout");
  redirect(back.startsWith("/ustawienia") ? back : "/ustawienia");
}
