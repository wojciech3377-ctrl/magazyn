"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCompany } from "@/lib/contracts/settings";
import { notifyAwaitingApproval } from "@/lib/contracts/store";
import { contractTotal } from "@/lib/contracts/purchase";
import { validateSignaturePng } from "@/lib/contracts/png";
import { COUNTRIES, CURRENCIES } from "@/lib/contracts/options";

type Result = { error?: string };

const clean = (v: FormDataEntryValue | null, max = 200) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

function parseSeller(formData: FormData) {
  const s = {
    name: clean(formData.get("name"), 120),
    idNumber: clean(formData.get("idNumber"), 30).toUpperCase(),
    street: clean(formData.get("street"), 120),
    postcode: clean(formData.get("postcode"), 10),
    city: clean(formData.get("city"), 80),
    bank: clean(formData.get("bank"), 40).toUpperCase(),
    email: clean(formData.get("email"), 120).toLowerCase(),
    phone: clean(formData.get("phone"), 30),
  };
  if (s.name.length < 5 || !s.name.includes(" ")) return { error: "Podaj imię i nazwisko." };
  if (s.idNumber.replace(/\s/g, "").length < 6) return { error: "Podaj PESEL albo numer dowodu osobistego." };
  const country = clean(formData.get("country"), 10).toUpperCase();
  if (!COUNTRIES.some((c) => c.code === country)) return { error: "Wybierz kraj. / Choose a country." };
  if (!s.street || !s.city || !s.postcode) return { error: "Podaj pełny adres z kodem pocztowym. / Enter your full address." };
  if (country === "PL" && !/^\d{2}-?\d{3}$/.test(s.postcode)) return { error: "Kod pocztowy w formacie 00-000." };
  const paymentMethod = String(formData.get("payment_method") ?? "");
  if (paymentMethod !== "transfer" && paymentMethod !== "cash") return { error: "Wybierz formę zapłaty: przelew albo gotówka. / Choose a payment method." };
  const currency = String(formData.get("currency") ?? "");
  if (!CURRENCIES.some((c) => c.code === currency)) return { error: "Wybierz walutę. / Choose a currency." };
  // Numer konta bez ograniczeń formatu – sprzedający wpisuje, co chce (wymagany tylko przy przelewie).
  const account = paymentMethod === "transfer" ? clean(formData.get("bank"), 80) : null;
  if (paymentMethod === "transfer" && !account) return { error: "Wpisz numer konta. / Enter your bank account number." };
  const contractDate = String(formData.get("contract_date") ?? "");
  const d = new Date(`${contractDate}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(contractDate) || Number.isNaN(d.getTime()) || Math.abs(d.getTime() - Date.now()) > 366 * 86400_000) {
    return { error: "Podaj poprawną datę zawarcia umowy. / Enter a valid date." };
  }
  const language = formData.get("language") === "en" ? "en" : "pl";
  if (s.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.email)) return { error: "Nieprawidłowy adres e-mail." };
  const signature = String(formData.get("signature") ?? "");
  const sigError = validateSignaturePng(signature);
  if (sigError) return { error: sigError };
  if (!formData.get("consent")) return { error: "Zaznacz akceptację treści umowy." };
  const postcode = country === "PL" && !s.postcode.includes("-") ? `${s.postcode.slice(0, 2)}-${s.postcode.slice(2)}` : s.postcode;
  return {
    seller: {
      seller_name: s.name,
      seller_id_number: s.idNumber,
      seller_address: `${s.street}, ${postcode} ${s.city}`,
      seller_bank_account: account,
      seller_country: country,
      payment_method: paymentMethod,
      currency,
      language,
      contract_date: contractDate,
      seller_email: s.email || null,
      seller_phone: s.phone || null,
      counterparty: s.name,
      seller_signature: signature,
    },
  };
}

async function requestMeta() {
  const h = await headers();
  return {
    signer_ip: (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || null,
    signer_user_agent: (h.get("user-agent") ?? "").slice(0, 300) || null,
  };
}

/** Umowa wygenerowana w aplikacji (link dla konkretnego sprzedającego). */
export async function signLinkedContract(token: string, _: Result | null, formData: FormData): Promise<Result> {
  if (formData.get("website")) return { error: "Błąd formularza." };
  const parsed = parseSeller(formData);
  if ("error" in parsed) return { error: parsed.error };
  const db = createAdminClient();
  const { data: c } = await db.from("contracts").select("id, status, sign_expires_at").eq("sign_token", token).maybeSingle();
  if (!c || c.status === "cancelled") return { error: "Ten link jest nieaktywny." };
  if (c.status === "signed") redirect(`/podpis/${token}`);
  if (c.sign_expires_at && new Date(c.sign_expires_at) < new Date()) return { error: "Link wygasł – poproś o nowy." };

  const { data: updated, error } = await db.from("contracts")
    .update({ ...parsed.seller, ...(await requestMeta()), status: "signed", signed_at: new Date().toISOString() })
    .eq("id", c.id).eq("status", "sent").select("id");
  if (error) return { error: "Nie udało się zapisać umowy. Spróbuj ponownie." };
  if (!updated?.length) redirect(`/podpis/${token}`);

  // Dalej sklep zatwierdza umowę w aplikacji – dopiero wtedy podpis kupującego, PDF i sztuki „w drodze”.
  await notifyAwaitingApproval(c.id);
  redirect(`/podpis/${token}`);
}

/** Ogólny link: klient sam wpisuje, co sprzedaje. Pozycje przypisujecie do katalogu w aplikacji. */
export async function submitGeneralContract(key: string, _: Result | null, formData: FormData): Promise<Result> {
  if (formData.get("website")) return { error: "Błąd formularza." };
  const db = createAdminClient();
  const { data: setting } = await db.from("app_settings").select("value").eq("key", "general_contract_link").maybeSingle();
  const cfg = setting?.value as { key?: string; enabled?: boolean } | undefined;
  if (!cfg?.enabled || cfg.key !== key) return { error: "Ten link jest nieaktywny." };

  const parsed = parseSeller(formData);
  if ("error" in parsed) return { error: parsed.error };
  // Prosty limit nadużyć: najwyżej 5 umów z ogólnego linku na godzinę z jednego adresu IP.
  const meta = await requestMeta();
  if (meta.signer_ip) {
    const { count } = await db.from("contracts").select("id", { count: "exact", head: true })
      .eq("source", "general").eq("signer_ip", meta.signer_ip).gte("created_at", new Date(Date.now() - 3600_000).toISOString());
    if ((count ?? 0) >= 5) return { error: "Za dużo umów w krótkim czasie. Spróbuj później albo napisz do nas." };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(String(formData.get("items") ?? "[]"));
  } catch {
    return { error: "Błąd listy przedmiotów." };
  }
  if (!Array.isArray(raw)) return { error: "Błąd listy przedmiotów." };
  const rows = raw.filter((i): i is Record<string, string> => !!i && typeof i === "object");
  const items = rows.slice(0, 20).map((i) => ({
    title: clean(i.title, 150),
    option: clean(i.option, 40) || "–",
    qty: Math.min(50, Math.max(1, Math.floor(Number(i.qty) || 1))),
    price: Math.round(Number(String(i.price).replace(",", ".").replace(/\s/g, "")) * 100) / 100,
  })).filter((i) => i.title);
  if (!items.length) return { error: "Wpisz, co sprzedajesz." };
  if (items.some((i) => !Number.isFinite(i.price) || i.price <= 0 || i.price > 1_000_000)) return { error: "Podaj cenę każdej rzeczy." };
  if (contractTotal(items) > 5_000_000) return { error: "Kwota umowy jest za wysoka – skontaktuj się z nami." };

  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const { data: c, error } = await db.from("contracts").insert({
    type: "purchase",
    template: "purchase_v1",
    source: "general",
    status: "signed",
    signed_at: new Date().toISOString(),
    amount: contractTotal(items),
    payment_days: (await getCompany(db)).payment_days ?? 7,
    items,
    sign_token: token,
    ...parsed.seller,
    ...meta,
  }).select("id").single();
  if (error) return { error: "Nie udało się zapisać umowy. Spróbuj ponownie." };
  await notifyAwaitingApproval(c.id);
  redirect(`/podpis/${token}`);
}
