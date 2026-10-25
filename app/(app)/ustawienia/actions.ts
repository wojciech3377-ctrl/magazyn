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
  // Adres aplikacji z konfiguracji (nie z nagłówka zapytania – webhooki nie mogą trafić pod obcą domenę).
  const { appUrl } = await import("@/lib/app-url");
  const base = await appUrl();
  if (!base.startsWith("https://")) return done("Webhooki rejestruj z opublikowanej aplikacji (adres https), nie lokalnie.", "blad");
  const turnOn = String(formData.get("live") ?? "1") === "1";
  try {
    if (turnOn) {
      const r = await registerProductWebhooks(store.shopify_domain, store.code, `${base}/api/shopify/webhook/${store.code}`);
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

/** Nazwa na paragonie dla pozycji z tej reguły (np. „Sznur”); pusta – nazwa produktu. */
export async function setExclusionName(formData: FormData) {
  const { supabase } = await requireAdmin();
  const name = String(formData.get("receipt_name") ?? "").trim().slice(0, 40) || null;
  const { error } = await supabase.from("catalog_exclusions").update({ receipt_name: name }).eq("id", String(formData.get("id")));
  if (error) return done(/receipt_name/.test(error.message) ? "Uruchom migrację 0070_receipt_names_line_overrides.sql w Supabase." : error.message, "blad");
  await done(name ? `Nazwa na paragonie: „${name}”.` : "Na paragonie – nazwa produktu.");
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
    await db.from("sync_log").insert({ job: "stock", ok: !r.errors.length, message: `Wyrównanie „${text}”: ${JSON.stringify(r)}` });
    if (r.errors.length) back(r.errors.join(" · "), "blad");
    if (r.master === "app") back(`Główny jest magazyn aplikacji – sztuki zostają, stan w Shopify ustawiony według aplikacji. ${r.totals.map((t) => `${t.store}: zmieniono ${t.pushed}`).join(" · ") || "Bez zmian."}`, "ok");
    const parts = r.totals.map((t) => `${t.store}: dodano ${t.added}, usunięto ${t.removed}`);
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

/** Kopia zapasowa danych teraz (poza codzienną automatyczną). */
export async function makeBackupNow() {
  await requireAdmin();
  const { createDbBackup } = await import("@/lib/backup");
  const { createAdminClient: admin } = await import("@/lib/supabase/admin");
  let msg: string;
  try {
    const r = await createDbBackup(admin());
    const { backupContractFiles } = await import("@/lib/backup");
    const f = await backupContractFiles(admin(), Date.now() + 60_000).catch(() => null);
    const rows = Object.values(r.counts).reduce((n, x) => n + x, 0);
    msg = `Kopia gotowa: ${r.path} (${(r.size / 1024 / 1024).toFixed(1)} MB, ${rows} wierszy, ${r.seconds} s).${Object.keys(r.skipped).length ? ` Pominięte tabele: ${Object.keys(r.skipped).join(", ")}.` : ""}${f ? ` Pliki umów: ${f.copied} nowych skopiowanych, w kopii razem ${f.copied + f.already} z ${f.total}.` : ""}`;
  } catch (e) {
    return done(errorMessage(e), "blad");
  }
  return done(msg);
}

/** Sklep-kopia (SQL 78): sklep źródłowy, lokalizacja Shopify kopii, zamiany tekstów w opisach. */
export async function saveMirror(formData: FormData) {
  const { supabase } = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const source = String(formData.get("mirror_of") ?? "");
  const loc = String(formData.get("mirror_location_id") ?? "");
  if (source === id) return done("Sklep nie może być kopią samego siebie.", "blad");
  if (source) {
    // Kopią może zostać tylko sklep bez własnego towaru (bez lokalizacji i własnych produktów) – inaczej aplikacja
    // nadpisałaby jego produkty produktami źródła. Źródło nie może być samo kopią.
    const db = createAdminClient();
    const [{ data: src }, { count: locCount }, { count: ownLinks }] = await Promise.all([
      db.from("stores").select("*").eq("id", source).maybeSingle(),
      db.from("locations").select("id", { count: "exact", head: true }).eq("store_id", id),
      db.from("product_store_links").select("id", { count: "exact", head: true }).eq("store_id", id).is("mirror_hash", null),
    ]);
    if (!src) return done("Nie ma takiego sklepu źródłowego.", "blad");
    if ((src as { mirror_of?: string | null }).mirror_of) return done("Sklep źródłowy sam jest kopią – wybierz sklep z własnym towarem.", "blad");
    if (locCount) return done("Ten sklep ma lokalizacje w aplikacji – kopią może być tylko sklep bez własnego towaru.", "blad");
    if (ownLinks) return done("Ten sklep ma już własne produkty w aplikacji – kopią może być tylko nowy sklep.", "blad");
  }
  if (loc && !/^gid:\/\/shopify\/Location\/\d+$/.test(loc)) return done("Wybierz lokalizację Shopify z listy.", "blad");
  const { error } = await supabase.from("stores").update({ mirror_of: source || null, ...(formData.has("mirror_location_id") ? { mirror_location_id: loc || null } : {}) }).eq("id", id);
  if (error) return done(/mirror_/.test(error.message) ? "Sklep-kopia wymaga SQL 78 w Supabase (0078_mirror_store.sql)." : error.message, "blad");
  if (formData.has("replace")) {
    const replace = String(formData.get("replace") ?? "").split("\n").map((l) => l.split("→").map((x) => x.trim())).filter((p) => p.length === 2 && p[0]).slice(0, 30);
    const admin = createAdminClient();
    const { data: prev } = await admin.from("app_settings").select("value").eq("key", "mirror").maybeSingle();
    const { error: e2 } = await admin.from("app_settings").upsert({ key: "mirror", value: { ...((prev?.value as object | null) ?? {}), replace } });
    if (e2) return done(e2.message, "blad");
    // Zmienione zasady zamiany – produkty już skopiowane wracają do kolejki (opisy w kopii dostaną nowy tekst).
    const prevRules = JSON.stringify((prev?.value as { replace?: unknown } | null)?.replace ?? []);
    if (prevRules !== JSON.stringify(replace)) {
      const requeued = await requeueMirrored(admin);
      if (requeued) return done(`Sklep-kopia zapisany. Nowe zasady zamiany – ${requeued} skopiowanych produktów zaktualizuje się w kolejnych przebiegach automatu.`);
    }
  }
  await done("Sklep-kopia zapisany.");
}

/**
 * Wykluczenia sklepu-kopii: kody metek produktów (PR000123) – te produkty nie trafiają do kopii, a już skopiowane
 * idą tam do archiwum (niewidoczne w sklepie). Usunięcie z listy – produkt wraca do kopii przy kolejnym przebiegu.
 */
export async function saveMirrorExclude(formData: FormData) {
  await requireAdmin();
  const { parseProductTagCode } = await import("@/lib/price-tag-code");
  const raw = String(formData.get("exclude") ?? "");
  const codes = [...new Set(raw.split(/[\s,;]+/).map((c) => c.trim().toUpperCase()).filter(Boolean))];
  if (codes.length > 2000) return done("Najwyżej 2000 wykluczonych produktów.", "blad");
  const bad = codes.filter((c) => parseProductTagCode(c) === null);
  if (bad.length) return done(`To nie są kody produktów (PR000123): ${bad.slice(0, 10).join(", ")}${bad.length > 10 ? "…" : ""}`, "blad");
  const admin = createAdminClient();
  const nos = codes.map((c) => parseProductTagCode(c)!);
  const found = new Map<number, string>();
  for (let i = 0; i < nos.length; i += 300) {
    const { data, error } = await admin.from("products").select("id, tag_no").in("tag_no", nos.slice(i, i + 300));
    if (error) return done(error.message, "blad");
    for (const p of data ?? []) found.set(Number(p.tag_no), p.id as string);
  }
  const missing = codes.filter((c) => !found.has(parseProductTagCode(c)!));
  if (missing.length) return done(`Nie ma produktów o kodach: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? "…" : ""} – nic nie zapisano.`, "blad");
  const { data: prev } = await admin.from("app_settings").select("value").eq("key", "mirror").maybeSingle();
  const before = new Set(((prev?.value as { exclude?: string[] } | null)?.exclude ?? []));
  const exclude = [...new Set(found.values())];
  const { error } = await admin.from("app_settings").upsert({ key: "mirror", value: { ...((prev?.value as object | null) ?? {}), exclude } });
  if (error) return done(error.message, "blad");
  // Nowo wykluczone (do archiwum w kopii) i zdjęte z listy (z powrotem do kopii) – do kolejki każdej kopii.
  const changed = [...exclude.filter((x) => !before.has(x)), ...[...before].filter((x) => !exclude.includes(x))];
  if (changed.length) {
    const { data: mirrors } = await admin.from("stores").select("id").not("mirror_of", "is", null);
    const now = new Date().toISOString();
    const rows = (mirrors ?? []).flatMap((m) => changed.map((product_id) => ({ store_id: m.id as string, product_id, queued_at: now, attempts: 0, last_error: null })));
    for (let i = 0; i < rows.length; i += 500) await admin.from("mirror_queue").upsert(rows.slice(i, i + 500), { onConflict: "store_id,product_id" });
  }
  await done(`Wykluczone produkty: ${exclude.length}.${changed.length ? ` Zmiana dotyczy ${changed.length} – kopia zaktualizuje je przy kolejnym przebiegu (co 30 min albo „Kopiuj produkty teraz”).` : ""}`);
}

/** Usuwanie z kopii produktów bez powiązania z magazynem (włącz / wyłącz). */
export async function saveMirrorDelete(formData: FormData) {
  await requireAdmin();
  const admin = createAdminClient();
  const on = formData.get("delete_orphans") !== null;
  const { data: prev } = await admin.from("app_settings").select("value").eq("key", "mirror").maybeSingle();
  const { error } = await admin.from("app_settings").upsert({ key: "mirror", value: { ...((prev?.value as object | null) ?? {}), deleteOrphans: on } });
  await done(error ? error.message : on ? "Usuwanie włączone – produkty bez powiązania znikną z kopii przy najbliższych przebiegach (co 30 min, po 50)." : "Usuwanie wyłączone.", error ? "blad" : "ok");
}

/** Wszystkie produkty już skopiowane (we wszystkich sklepach-kopiach) – z powrotem do kolejki. */
async function requeueMirrored(db: ReturnType<typeof createAdminClient>) {
  const now = new Date().toISOString();
  let n = 0;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("product_store_links").select("store_id, product_id").not("mirror_hash", "is", null).order("id").range(from, from + 999);
    if (error || !data?.length) break;
    const rows = data.map((r) => ({ store_id: r.store_id as string, product_id: r.product_id as string, queued_at: now, attempts: 0, last_error: null }));
    const { error: e } = await db.from("mirror_queue").upsert(rows, { onConflict: "store_id,product_id" });
    if (!e) n += rows.length;
    if (data.length < 1000) break;
  }
  // Produkty spoza magazynu (SQL 79) – też od nowa przy kolejnym przebiegu.
  await db.from("mirror_extra").update({ source_updated_at: null }).not("store_id", "is", null);
  return n;
}

/** Utworzenie / aktualizacja produktów w sklepach-kopiach teraz (do ~3 minut, reszta przy kolejnym przebiegu automatu). */
export async function runMirrorNow() {
  await requireAdmin();
  const { runMirror } = await import("@/lib/sync/mirror");
  const admin = createAdminClient();
  const r = await runMirror(admin, { deadline: Date.now() + 150_000, backfill: 2000 }).catch((e) => ({ błąd: errorMessage(e) }));
  // Produkty spoza magazynu (np. Rope) – w czasie, który został.
  const { runMirrorExtras } = await import("@/lib/sync/mirror");
  const ex = await runMirrorExtras(admin, { deadline: Date.now() + 60_000 }).catch((e) => ({ błąd: errorMessage(e) }));
  for (const [k, v] of Object.entries(ex)) (r as Record<string, unknown>)[`${k} (spoza magazynu, np. Rope)`] = v;
  const text = Object.entries(r).map(([k, v]) => `${k}: ${typeof v === "string" ? v : Object.entries(v as Record<string, unknown>).filter(([kk]) => kk !== "errors").map(([kk, vv]) => `${kk.replace(/_/g, " ")} ${vv}`).join(", ")}`).join(" · ");
  const errs = Object.values(r).flatMap((v) => (v && typeof v === "object" && "errors" in v ? (v as { errors: string[] }).errors : []));
  await done(`${text || "Brak sklepów-kopii z domeną Shopify."}${errs.length ? ` Błędy: ${errs.join("; ")}` : ""}`, errs.length ? "blad" : "ok");
}

/** Produkty, które nie przeszły do kopii (8 prób) – jeszcze raz. */
export async function retryMirror(formData: FormData) {
  await requireAdmin();
  const { error } = await createAdminClient().from("mirror_queue").update({ attempts: 0 }).eq("store_id", String(formData.get("id") ?? "")).gte("attempts", 1);
  // Produkty spoza magazynu (SQL 79) – też od nowa (bez SQL 79 – pomijane).
  await createAdminClient().from("mirror_extra").update({ attempts: 0, source_updated_at: null }).eq("store_id", String(formData.get("id") ?? "")).gte("attempts", 1);
  await done(error ? error.message : "Produkty z błędem wrócą do kopiowania przy najbliższym przebiegu (albo kliknij „Kopiuj teraz”).", error ? "blad" : "ok");
}
