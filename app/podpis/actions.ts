"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCompany } from "@/lib/contracts/settings";
import { storePdfAndNotify } from "@/lib/contracts/store";
import { contractTotal } from "@/lib/contracts/purchase";
import { validateSignaturePng } from "@/lib/contracts/png";

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
  if (!s.street || !s.city || !/^\d{2}-?\d{3}$/.test(s.postcode)) return { error: "Podaj pełny adres z kodem pocztowym (np. 61-850)." };
  const letters = s.bank.replace(/[^A-Z]/g, "");
  const digits = s.bank.replace(/[^0-9]/g, "");
  if ((letters && letters !== "PL") || digits.length !== 26) return { error: "Podaj polski numer konta: 26 cyfr (może być z PL na początku)." };
  if (s.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.email)) return { error: "Nieprawidłowy adres e-mail." };
  const signature = String(formData.get("signature") ?? "");
  const sigError = validateSignaturePng(signature);
  if (sigError) return { error: sigError };
  if (!formData.get("consent")) return { error: "Zaznacz akceptację treści umowy." };
  const postcode = s.postcode.includes("-") ? s.postcode : `${s.postcode.slice(0, 2)}-${s.postcode.slice(2)}`;
  return {
    seller: {
      seller_name: s.name,
      seller_id_number: s.idNumber,
      seller_address: `${s.street}, ${postcode} ${s.city}`,
      seller_bank_account: `PL${digits}`,
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
    .update({ ...parsed.seller, ...(await requestMeta()), status: "signed", signed_at: new Date().toISOString(), contract_date: new Date().toISOString().slice(0, 10) })
    .eq("id", c.id).eq("status", "sent").select("id");
  if (error) return { error: "Nie udało się zapisać umowy. Spróbuj ponownie." };
  if (!updated?.length) redirect(`/podpis/${token}`);

  const fin = await db.rpc("finalize_contract", { p_contract_id: c.id });
  if (fin.error) await db.from("sync_log").insert({ job: "contract-finalize", ok: false, message: `${c.id}: ${fin.error.message}` });
  await storePdfAndNotify(c.id, { emailSeller: true });
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
    contract_date: new Date().toISOString().slice(0, 10),
    amount: contractTotal(items),
    payment_days: (await getCompany(db)).payment_days ?? 7,
    items,
    sign_token: token,
    ...parsed.seller,
    ...meta,
  }).select("id").single();
  if (error) return { error: "Nie udało się zapisać umowy. Spróbuj ponownie." };
  // Ogólny link: bez wysyłki na adres podany przez klienta (nie może to być bramka do spamu) – PDF pobierze ze strony.
  await storePdfAndNotify(c.id, { emailSeller: false });
  redirect(`/podpis/${token}`);
}
