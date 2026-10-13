"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSection } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCompany } from "@/lib/contracts/settings";
import { contractTotal } from "@/lib/contracts/purchase";
import { uploadedFile } from "@/lib/contracts/upload";
import { errorMessage } from "@/lib/errors";

const UUID = /^[0-9a-f-]{36}$/;
const back = (key: "ok" | "blad", msg: string): never => redirect(`/dostawa?zakladka=w-drodze&${key}=${encodeURIComponent(msg)}`);

type Picked = { unit_id: string; price: string };

/** Zaznaczone rzeczy w drodze (bez umowy) z cenami zakupu. */
async function pickedUnits(fd: FormData) {
  let raw: Picked[] = [];
  try { raw = JSON.parse(String(fd.get("units") ?? "[]")); } catch { raw = []; }
  raw = raw.filter((r) => UUID.test(String(r.unit_id))).slice(0, 100);
  if (!raw.length) back("blad", "Zaznacz rzeczy w drodze.");
  const db = createAdminClient();
  const { data } = await db.from("units").select("id, code, identifier, variant_id, location_id, purchase_price, contract_id, status, variant:variants(option, product:products(title))")
    .in("id", raw.map((r) => r.unit_id));
  type U = { id: string; code: string; identifier: string | null; variant_id: string; location_id: string; purchase_price: number | null; contract_id: string | null; status: string; variant: { option: string; product: { title: string } } };
  const units = ((data ?? []) as unknown as U[]).filter((u) => !u.contract_id);
  if (!units.length) back("blad", "Te rzeczy mają już umowę albo fakturę.");
  const price = (u: U) => {
    const typed = raw.find((r) => r.unit_id === u.id)?.price;
    const n = typed && String(typed).trim() ? Number(String(typed).replace(/\s/g, "").replace(",", ".")) : Number(u.purchase_price ?? NaN);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
  };
  return { db, units, price };
}

/**
 * „Umowa” jednym kliknięciem: umowa kupna do podpisu przez sprzedającego (link) dla zaznaczonych rzeczy w drodze.
 * Po podpisie i zatwierdzeniu każdy but dostaje osobną umowę z własnym numerem (podział jak w Umowach).
 */
export async function transitContract(fd: FormData) {
  const { supabase } = await requireSection("dostawa", "umowy");
  const { db, units, price } = await pickedUnits(fd);
  const items = units.map((u) => ({ unit_id: u.id, variant_id: u.variant_id, title: u.variant.product.title, option: u.variant.option, identifier: u.identifier, qty: 1, price: price(u) }));
  const bad = items.find((i) => !(i.price > 0));
  if (bad) back("blad", `Podaj cenę zakupu dla: ${bad.title} ${bad.option}`);
  const company = await getCompany(supabase);
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const { data: c, error } = await supabase.from("contracts").insert({
    type: "purchase", template: "purchase_v1", source: "link", status: "sent", counterparty: "(czeka na podpis)",
    amount: contractTotal(items), payment_days: company.payment_days ?? 7, items,
    location_id: units[0].location_id,
    seller_email: String(fd.get("seller_email") ?? "").trim() || null,
    sign_token: token, sign_expires_at: new Date(Date.now() + 14 * 86400_000).toISOString(),
    notes: "Umowa do rzeczy w drodze (Przyjęcie dostawy → W drodze).",
  }).select("id").single();
  if (error) back("blad", errorMessage(error));
  await db.from("units").update({ contract_id: c!.id }).in("id", units.map((u) => u.id)).is("contract_id", null);
  revalidatePath("/dostawa");
  redirect(`/umowy/${c!.id}?ok=${encodeURIComponent(`Umowa na ${items.length} szt. gotowa – wyślij sprzedającemu link do podpisu. Po zatwierdzeniu każda para dostanie osobną umowę.`)}`);
}

/** Faktura od sprzedawcy dla zaznaczonych rzeczy w drodze: jeden dokument (ten sam plik) przy każdym bucie. */
export async function transitInvoice(fd: FormData) {
  await requireSection("dostawa", "umowy");
  const { db, units, price } = await pickedUnits(fd);
  let file: { path: string; name: string } | null;
  try { file = uploadedFile(fd); } catch { file = null; }
  if (!file) back("blad", "Dołącz plik faktury (PDF albo zdjęcie).");
  const docNumber = String(fd.get("doc_number") ?? "").trim().slice(0, 60);
  if (!docNumber) back("blad", "Wpisz numer faktury.");
  const counterparty = String(fd.get("counterparty") ?? "").trim().slice(0, 200) || "Sprzedawca (faktura)";
  const date = String(fd.get("doc_date") ?? "");
  const items = units.map((u) => ({ unit_id: u.id, variant_id: u.variant_id, title: u.variant.product.title, option: u.variant.option, identifier: u.identifier, qty: 1, price: Number.isFinite(price(u)) ? price(u) : 0 }));
  const { data: c, error } = await db.from("contracts").insert({
    type: "invoice", status: "accepted", counterparty, doc_number: docNumber,
    contract_date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
    amount: contractTotal(items) || null, currency: "PLN", items,
    file_path: file!.path, file_name: file!.name,
    notes: `Faktura do ${units.length} szt. w drodze – ten sam dokument przy każdej rzeczy.`,
  }).select("id").single();
  if (error) back("blad", errorMessage(error));
  await db.from("units").update({ contract_id: c!.id }).in("id", units.map((u) => u.id)).is("contract_id", null);
  // Cena zakupu wpisana przy rzeczy – zapis w sztuce.
  for (const u of units) {
    const p = price(u);
    if (Number.isFinite(p) && p > 0 && Number(u.purchase_price ?? 0) !== p) await db.from("units").update({ purchase_price: p }).eq("id", u.id);
  }
  revalidatePath("/dostawa");
  back("ok", `Faktura ${docNumber} dołączona do ${units.length} szt. w drodze.`);
}
