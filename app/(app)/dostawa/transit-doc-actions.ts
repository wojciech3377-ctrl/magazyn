"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSection } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCompany } from "@/lib/contracts/settings";
import { contractTotal } from "@/lib/contracts/purchase";
import { uploadedFile } from "@/lib/contracts/upload";
import { errorMessage } from "@/lib/errors";
import { adjustStock } from "@/lib/stock";

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
  const { data } = await db.from("units").select("*, variant:variants(option, product:products(title))")
    .in("id", raw.map((r) => r.unit_id));
  type U = { id: string; code: string; identifier: string | null; variant_id: string; location_id: string; purchase_price: number | null; contract_id: string | null; status: string; supplier?: string | null; variant: { option: string; product: { title: string } } };
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
  // Waluta wybrana tutaj – sprzedający jej nie zmieni; pusta – wybierze ją przy podpisie.
  const currency = ["PLN", "EUR"].includes(String(fd.get("currency"))) ? String(fd.get("currency")) : null;
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const { data: c, error } = await supabase.from("contracts").insert({
    type: "purchase", template: "purchase_v1", source: "link", status: "sent", counterparty: units.find((u) => u.supplier)?.supplier ?? "(czeka na podpis)",
    amount: contractTotal(items), payment_days: company.payment_days ?? 7, items, currency,
    location_id: units[0].location_id,
    seller_email: String(fd.get("seller_email") ?? "").trim() || null,
    sign_token: token, sign_expires_at: new Date(Date.now() + 14 * 86400_000).toISOString(),
    notes: "Umowa do rzeczy w drodze (Przyjęcie dostawy → W drodze).",
  }).select("id").single();
  if (error) back("blad", errorMessage(error));
  if (fd.get("no_unit")) {
    // „Nie dodawaj jako przedmiot w magazynie”: rzeczy już są w Magazynie – sztuki „w drodze” znikają,
    // umowa po podpisie i zatwierdzeniu trafia do niewykorzystanych (przypinasz ją na karcie sztuki).
    const gone = await dropTransitUnits(db, units.map((u) => u.id));
    revalidatePath("/dostawa");
    redirect(`/umowy/${c!.id}?ok=${encodeURIComponent(`Umowa na ${items.length} szt. gotowa – bez nowych sztuk w magazynie (${gone} usunięte z W drodze). Po zatwierdzeniu trafi do niewykorzystanych.`)}`);
  }
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
    amount: contractTotal(items) || null, currency: fd.get("currency") === "EUR" ? "EUR" : "PLN", items,
    file_path: file!.path, file_name: file!.name,
    notes: `Faktura do ${units.length} szt. w drodze – ten sam dokument przy każdej rzeczy.`,
  }).select("id").single();
  if (error) back("blad", errorMessage(error));
  if (fd.get("no_unit")) {
    const gone = await dropTransitUnits(db, units.map((u) => u.id));
    revalidatePath("/dostawa");
    back("ok", `Faktura ${docNumber} zapisana bez nowych sztuk w magazynie (${gone} usunięte z W drodze) – jest w Umowach → „Bez rzeczy (niewykorzystane)”.`);
  }
  await db.from("units").update({ contract_id: c!.id }).in("id", units.map((u) => u.id)).is("contract_id", null);
  // Waluta cen sztuk jak na fakturze (bez SQL 67 – pomijane).
  await db.from("units").update({ purchase_currency: fd.get("currency") === "EUR" ? "EUR" : "PLN" }).in("id", units.map((u) => u.id)).then(() => null, () => null);
  // Cena zakupu wpisana przy rzeczy – zapis w sztuce.
  for (const u of units) {
    const p = price(u);
    if (Number.isFinite(p) && p > 0 && Number(u.purchase_price ?? 0) !== p) await db.from("units").update({ purchase_price: p }).eq("id", u.id);
  }
  revalidatePath("/dostawa");
  back("ok", `Faktura ${docNumber} dołączona do ${units.length} szt. w drodze.`);
}

/** Zaznaczone rzeczy w drodze bez dokumentu → na stan (umowę albo fakturę dopniesz później). */
export async function receiveNoDocUnits(fd: FormData) {
  const { supabase } = await requireSection("dostawa");
  const ids = fd.getAll("unit").map(String).filter((x) => UUID.test(x)).slice(0, 300);
  if (!ids.length) back("blad", "Zaznacz rzeczy, które dotarły.");
  const { data, error } = await supabase.rpc("receive_in_transit", { p_unit_ids: ids });
  if (error) back("blad", errorMessage(error));
  const rows = (data ?? []) as { unit_id: string; variant_id: string; location_id: string; to_status: string }[];
  const toStock = rows.filter((r) => r.to_status === "in_stock");
  const results = await adjustStock(supabase, toStock.map((u) => ({ variantId: u.variant_id, locationId: u.location_id, delta: 1 })));
  revalidatePath("/dostawa");
  revalidatePath("/magazyn");
  const failed = results.filter((r) => !r.ok);
  back(failed.length ? "blad" : "ok", `Przyjęto ${rows.length} szt.: na stan ${toStock.length}${rows.length - toStock.length ? `, do zamówień ${rows.length - toStock.length}` : ""}. Bez umowy – dopniesz ją w Magazynie.${failed.length ? ` Shopify: ${failed.map((f) => f.message).join("; ")}` : ""}`);
}

/** Sztuki „w drodze” bez umowy i bez sprzedaży – usunięcie (rzecz już jest w Magazynie). Zwraca liczbę usuniętych. */
async function dropTransitUnits(db: ReturnType<typeof createAdminClient>, ids: string[]) {
  const { data: sold } = await db.from("sales").select("unit_id").in("unit_id", ids);
  const skip = new Set((sold ?? []).map((x) => x.unit_id as string));
  const del = ids.filter((x) => !skip.has(x));
  if (!del.length) return 0;
  const { data } = await db.from("units").delete().in("id", del).eq("status", "in_transit").is("contract_id", null).select("id");
  revalidatePath("/magazyn");
  return data?.length ?? 0;
}

/** „Nie dodawaj jako przedmiot w magazynie” bez dokumentu – zaznaczone rzeczy znikają z W drodze. */
export async function dropNoDocUnits(fd: FormData) {
  await requireSection("dostawa");
  const ids = fd.getAll("unit").map(String).filter((x) => UUID.test(x)).slice(0, 300);
  if (!ids.length) back("blad", "Zaznacz rzeczy.");
  const gone = await dropTransitUnits(createAdminClient(), ids);
  revalidatePath("/dostawa");
  back("ok", `Usunięto z W drodze ${gone} szt. – bez nowych sztuk w magazynie.`);
}

/** W drodze → notatka (np. „paczka od Kowalskiego, 2 pary”) z polem „Doszło”. */
export async function addTransitNote(fd: FormData) {
  const { supabase } = await requireSection("dostawa");
  const text = String(fd.get("text") ?? "").trim().slice(0, 500);
  if (!text) back("blad", "Wpisz treść notatki.");
  const { error } = await supabase.from("transit_notes").insert({ text });
  if (error) back("blad", /transit_notes/.test(error.message) ? "Notatki w W drodze wymagają SQL 75 w Supabase (0075_transit_notes.sql)." : error.message);
  revalidatePath("/dostawa");
  back("ok", "Notatka dodana.");
}

/** „Doszło” – zaznaczenie / odznaczenie notatki; „usuń” – usunięcie. */
export async function toggleTransitNote(fd: FormData) {
  const { supabase, profile } = await requireSection("dostawa");
  const id = String(fd.get("id") ?? "");
  if (!UUID.test(id)) back("blad", "Zła notatka.");
  if (fd.get("delete")) {
    // Usuwa autor albo administrator.
    const { data: n } = await supabase.from("transit_notes").select("created_by").eq("id", id).maybeSingle();
    if (profile.role !== "admin" && n?.created_by !== profile.id) back("blad", "Notatkę może usunąć jej autor albo administrator.");
    await supabase.from("transit_notes").delete().eq("id", id);
  } else {
    const arrived = fd.get("arrived") === "1";
    await supabase.from("transit_notes").update(arrived ? { arrived_at: new Date().toISOString(), arrived_by: profile.id } : { arrived_at: null, arrived_by: null }).eq("id", id);
  }
  revalidatePath("/dostawa");
  redirect("/dostawa?zakladka=w-drodze");
}

/** Edycja treści notatki – tylko administrator. */
export async function editTransitNote(fd: FormData) {
  const { requireAdmin } = await import("@/lib/auth");
  const { supabase } = await requireAdmin();
  const id = String(fd.get("id") ?? "");
  const text = String(fd.get("text") ?? "").trim().slice(0, 500);
  if (!UUID.test(id) || !text) back("blad", "Wpisz treść notatki.");
  const { error } = await supabase.from("transit_notes").update({ text }).eq("id", id);
  if (error) back("blad", error.message);
  revalidatePath("/dostawa");
  back("ok", "Notatka zmieniona.");
}
