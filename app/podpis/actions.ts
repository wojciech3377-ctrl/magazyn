"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCompany } from "@/lib/contracts/settings";
import { notifyAwaitingApproval } from "@/lib/contracts/store";
import { contractTotal } from "@/lib/contracts/purchase";
import { escapeHtml, validateSignaturePng } from "@/lib/contracts/png";
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
  // Pozycje wybrane z katalogu: nazwę i rozmiar bierzemy z bazy (nie z formularza).
  const variantIds = rows.map((i) => String(i.variant_id ?? "")).filter((v) => /^[0-9a-f-]{36}$/.test(v));
  const { data: catalog } = variantIds.length
    ? await db.from("variants").select("id, option, product:products(title)").in("id", variantIds.slice(0, 20))
    : { data: [] };
  const known = new Map((catalog ?? []).map((v) => [v.id as string, { option: v.option as string, title: (v.product as unknown as { title: string }).title }]));
  const items = rows.slice(0, 20).map((i) => {
    const v = known.get(String(i.variant_id ?? ""));
    return {
      ...(v ? { variant_id: String(i.variant_id) } : {}),
      title: v?.title ?? clean(i.title, 150),
      option: v?.option ?? (clean(i.option, 40) || "–"),
      qty: Math.min(50, Math.max(1, Math.floor(Number(i.qty) || 1))),
      price: Math.round(Number(String(i.price).replace(",", ".").replace(/\s/g, "")) * 100) / 100,
    };
  }).filter((i) => i.title);
  if (!items.length) return { error: "Wpisz, co sprzedajesz." };
  if (items.some((i) => !Number.isFinite(i.price) || i.price <= 0 || i.price > 1_000_000)) return { error: "Podaj cenę każdej rzeczy." };
  if (contractTotal(items) > 5_000_000) return { error: "Kwota umowy jest za wysoka – skontaktuj się z nami." };

  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  // Wybrany sklep → towar przyjdzie do jego pierwszej aktywnej lokalizacji (można zmienić przy zatwierdzeniu).
  const storeId = String(formData.get("store_id") ?? "");
  const { data: loc } = /^[0-9a-f-]{36}$/.test(storeId)
    ? await db.from("locations").select("id").eq("store_id", storeId).eq("active", true).order("created_at").limit(1).maybeSingle()
    : { data: null };
  const { data: c, error } = await db.from("contracts").insert({
    location_id: loc?.id ?? null,
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

/** Odpowiedź sprzedającego na naszą ofertę cenową: akceptacja (nowy podpis, umowa zawarta) albo odmowa. */
export async function respondContractOffer(token: string, _: Result | null, formData: FormData): Promise<Result> {
  if (formData.get("website")) return { error: "Błąd formularza." };
  const db = createAdminClient();
  const { data: c } = await db.from("contracts").select("id, status, items, offer, sign_expires_at, location_id, number").eq("sign_token", token).maybeSingle();
  if (!c || c.status !== "offer") return { error: "Ta oferta nie czeka już na odpowiedź." };
  if (c.sign_expires_at && new Date(c.sign_expires_at) < new Date()) return { error: "Oferta wygasła – skontaktuj się z nami." };
  const decision = String(formData.get("decision") ?? "");
  if (decision !== "accept" && decision !== "decline") return { error: "Wybierz: akceptuję albo odrzucam. / Choose accept or decline." };
  const offer = (c.offer ?? {}) as { prices?: number[]; location_id?: string | null };
  const meta = await requestMeta();

  if (decision === "decline") {
    const { data: done } = await db.from("contracts").update({ status: "rejected", offer_responded_at: new Date().toISOString(), notes: "Sprzedający odrzucił ofertę cenową." })
      .eq("id", c.id).eq("status", "offer").select("id");
    if (done?.length) {
      await db.from("units").update({ contract_id: null }).eq("contract_id", c.id);
      await notifyOfferAnswer(c.id, false);
    }
    redirect(`/podpis/${token}/oferta`);
  }

  if (!formData.get("consent")) return { error: "Zaznacz akceptację nowych cen. / Please confirm the new prices." };
  const signature = String(formData.get("signature") ?? "");
  const sigError = validateSignaturePng(signature);
  if (sigError) return { error: sigError };
  const items = ((c.items ?? []) as { price: number }[]).map((it, idx) => ({ ...it, price: Number(offer.prices?.[idx] ?? it.price) }));
  const { data: done, error } = await db.from("contracts").update({
    status: "accepted", accepted_at: new Date().toISOString(), offer_responded_at: new Date().toISOString(),
    items, amount: contractTotal(items as unknown as Parameters<typeof contractTotal>[0]), seller_signature: signature,
    location_id: c.location_id ?? offer.location_id ?? null, ...meta,
  }).eq("id", c.id).eq("status", "offer").select("id");
  if (error) return { error: "Nie udało się zapisać odpowiedzi. Spróbuj ponownie." };
  if (!done?.length) redirect(`/podpis/${token}/oferta`);
  // Umowa zawarta na nowych cenach: sztuki „w drodze”, PDF z podpisami, powiadomienie sklepu.
  const its = items as { unit_id?: string; variant_id?: string }[];
  if (its.every((i) => i.unit_id || i.variant_id)) {
    const fin = await db.rpc("finalize_contract", { p_contract_id: c.id });
    if (fin.error) await db.from("sync_log").insert({ job: "contract-offer", ok: false, message: `${c.id}: ${fin.error.message}` });
  }
  const { deliverAcceptedContract } = await import("@/lib/contracts/store");
  await deliverAcceptedContract(c.id);
  await notifyOfferAnswer(c.id, true);
  redirect(`/podpis/${token}/oferta`);
}

async function notifyOfferAnswer(contractId: string, accepted: boolean) {
  const db = createAdminClient();
  try {
    const { mailConfigured, sendMail } = await import("@/lib/mail");
    if (!(await mailConfigured())) return;
    const { data: c } = await db.from("contracts").select("number, seller_name").eq("id", contractId).single();
    const company = await getCompany(db);
    if (!company.email) return;
    await sendMail(company.email, `Umowa nr ${c?.number}: oferta ${accepted ? "zaakceptowana" : "odrzucona"}`,
      accepted
        ? `<p>${escapeHtml(c?.seller_name ?? "Sprzedający")} zaakceptował(a) nowe ceny w umowie nr ${c?.number}. Umowa jest zawarta – towar czeka w Przyjęciu dostawy → W drodze.</p>`
        : `<p>${escapeHtml(c?.seller_name ?? "Sprzedający")} odrzucił(a) ofertę cenową do umowy nr ${c?.number}. Umowa jest odrzucona.</p>`);
  } catch {
    // powiadomienie nie jest konieczne
  }
}
