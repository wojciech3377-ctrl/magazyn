"use server";

import { revalidatePath } from "next/cache";
import { requireConsignor } from "@/lib/consignment";
import { findVariantIds } from "@/lib/queries/units";
import { escHtml, itemsTable, mailCompany, refreshIntakeStatus } from "@/lib/intake";
import { errorMessage } from "@/lib/errors";

export type IntakeState = { ok?: string; error?: string } | null;
export type CatalogHit = { variantId: string; title: string; option: string; image: string | null };

const UUID = /^[0-9a-f-]{36}$/;
const money = (v: unknown) => {
  const n = Number(String(v ?? "").replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) && n > 0 && n < 1_000_000 ? Math.round(n * 100) / 100 : null;
};

/** Wyszukiwarka produktów z naszego katalogu dla komisanta (nazwa, SKU, EAN) – tylko nazwa i rozmiar. */
export async function searchCatalog(q: string): Promise<CatalogHit[]> {
  const { db } = await requireConsignor();
  const text = q.trim().replace(/[,()*%\\]/g, " ").trim();
  if (text.length < 2) return [];
  const ids = await findVariantIds(db, text);
  if (!ids.length) return [];
  const { data } = await db.from("variants").select("id, option, position, product:products(title, image_url)").in("id", ids.slice(0, 60));
  const collator = new Intl.Collator("pl", { numeric: true });
  return (data ?? []).map((v) => {
    const p = v.product as unknown as { title: string; image_url: string | null };
    return { variantId: v.id as string, title: p.title, option: v.option as string, image: p.image_url };
  }).sort((a, b) => a.title.localeCompare(b.title) || collator.compare(a.option, b.option)).slice(0, 40);
}

/** Nowe zgłoszenie: rzeczy, które komisant chce nam wysłać, z jego kwotami – czeka na naszą decyzję. */
export async function createIntake(_: IntakeState, fd: FormData): Promise<IntakeState> {
  const { db, consignor } = await requireConsignor();
  const locationId = String(fd.get("location_id") ?? "");
  const { data: loc } = UUID.test(locationId) ? await db.from("locations").select("id, name").eq("id", locationId).eq("active", true).maybeSingle() : { data: null };
  if (!loc) return { error: "Wybierz adres, na który wyślesz rzeczy." };
  let raw: unknown;
  try {
    raw = JSON.parse(String(fd.get("items") ?? "[]"));
  } catch {
    return { error: "Błąd listy rzeczy." };
  }
  const rows = (Array.isArray(raw) ? raw : []).filter((r): r is Record<string, unknown> => !!r && typeof r === "object").slice(0, 50);
  if (!rows.length) return { error: "Dodaj co najmniej jedną rzecz." };
  const variantIds = rows.map((r) => String(r.variant_id ?? "")).filter((v) => UUID.test(v));
  const { data: known } = variantIds.length ? await db.from("variants").select("id, option, product:products(title)").in("id", variantIds) : { data: [] };
  const byId = new Map((known ?? []).map((v) => [v.id as string, { title: (v.product as unknown as { title: string }).title, option: v.option as string }]));
  const items = [];
  for (const [i, r] of rows.entries()) {
    const v = byId.get(String(r.variant_id ?? ""));
    const title = v?.title ?? String(r.title ?? "").replace(/\s+/g, " ").trim().slice(0, 150);
    const option = v?.option ?? (String(r.option ?? "").trim().slice(0, 40) || null);
    const price = money(r.price);
    if (!title) return { error: `Pozycja ${i + 1}: wybierz produkt albo wpisz nazwę.` };
    if (!price) return { error: `Podaj swoją kwotę dla: ${title}${option ? ` ${option}` : ""}.` };
    items.push({ position: i, variant_id: v ? String(r.variant_id) : null, title, option, proposed_price: price });
  }
  const { data: intake, error } = await db.from("consignor_intakes").insert({
    consignor_id: consignor.id, location_id: loc.id, note: String(fd.get("note") ?? "").trim().slice(0, 500) || null,
  }).select("id").single();
  if (error || !intake) return { error: `Nie udało się zapisać zgłoszenia: ${errorMessage(error)}` };
  const { error: iErr } = await db.from("consignor_intake_items").insert(items.map((it) => ({ ...it, intake_id: intake.id })));
  if (iErr) {
    await db.from("consignor_intakes").delete().eq("id", intake.id);
    return { error: `Nie udało się zapisać rzeczy: ${errorMessage(iErr)}` };
  }
  await mailCompany(db, `Komis: ${consignor.name} chce wysłać ${items.length} szt. – do akceptacji`,
    `<p>Komisant <b>${escHtml(consignor.name)}</b> zgłosił rzeczy do wysłania na ${escHtml(loc.name as string)}:</p>${itemsTable(items.map((i) => ({ title: i.title, option: i.option, price: i.proposed_price })))}<p>Zdecyduj w aplikacji: Przyjęcie dostawy → Do akceptacji (Tak / Nie / Oferta).</p>`);
  revalidatePath("/komis");
  return { ok: `Zgłoszenie wysłane (${items.length} szt.). Damy znać e-mailem, gdy je sprawdzimy – nie wysyłaj jeszcze paczki.` };
}

/** Odpowiedź komisanta na nasze oferty cenowe: akceptacja albo odmowa każdej pozycji. */
export async function respondIntakeOffer(_: IntakeState, fd: FormData): Promise<IntakeState> {
  const { db, consignor } = await requireConsignor();
  const intakeId = String(fd.get("intake_id") ?? "");
  const { data: intake } = await db.from("consignor_intakes").select("id, status").eq("id", intakeId).eq("consignor_id", consignor.id).maybeSingle();
  if (!intake || intake.status !== "offer") return { error: "To zgłoszenie nie czeka na Twoją odpowiedź." };
  const { data: offered } = await db.from("consignor_intake_items").select("id, title, option, offer_price").eq("intake_id", intakeId).eq("status", "offered");
  const answers = (offered ?? []).map((i) => ({ ...i, answer: String(fd.get(`odp_${i.id}`) ?? "") }));
  if (answers.some((a) => a.answer !== "accept" && a.answer !== "decline")) return { error: "Zaznacz przy każdej rzeczy: akceptuję albo odmawiam." };
  for (const a of answers) {
    await db.from("consignor_intake_items").update(a.answer === "accept" ? { status: "accepted", final_price: a.offer_price } : { status: "declined" })
      .eq("id", a.id).eq("status", "offered");
  }
  const next = await refreshIntakeStatus(db, intakeId);
  const accepted = answers.filter((a) => a.answer === "accept");
  await mailCompany(db, `Komis: ${consignor.name} odpowiedział na ofertę (${accepted.length}/${answers.length} zaakceptowane)`,
    itemsTable(answers.map((a) => ({ title: a.title as string, option: a.option as string | null, price: Number(a.offer_price), note: a.answer === "accept" ? "akceptuje" : "odmawia" }))));
  revalidatePath("/komis");
  return { ok: next === "to_send" ? "Dziękujemy! Teraz wyślij paczkę i wpisz numer przesyłki poniżej." : "Dziękujemy za odpowiedź." };
}

/** Numer przesyłki do paczki z przyjętymi rzeczami. */
export async function addIntakeTracking(_: IntakeState, fd: FormData): Promise<IntakeState> {
  const { db, consignor } = await requireConsignor();
  const intakeId = String(fd.get("intake_id") ?? "");
  const tracking = String(fd.get("tracking") ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  const carrier = String(fd.get("carrier") ?? "").trim().slice(0, 60) || null;
  if (tracking.length < 4) return { error: "Wpisz numer przesyłki." };
  const { data: upd } = await db.from("consignor_intakes").update({ status: "sent", tracking, carrier, sent_at: new Date().toISOString() })
    .eq("id", intakeId).eq("consignor_id", consignor.id).in("status", ["to_send", "sent"]).select("id");
  if (!upd?.length) return { error: "Do tej paczki nie można już dodać numeru." };
  await mailCompany(db, `Komis: ${consignor.name} wysłał paczkę (${tracking})`, `<p>Komisant <b>${escHtml(consignor.name)}</b> wysłał paczkę: <b>${escHtml(tracking)}</b>${carrier ? ` (${escHtml(carrier)})` : ""}.</p><p>Po dotarciu przyjmij ją w aplikacji: Przyjęcie dostawy → W drodze.</p>`);
  revalidatePath("/komis");
  return { ok: "Numer przesyłki zapisany. Damy znać, gdy paczka dotrze." };
}

/** Komisant wycofuje zgłoszenie, dopóki paczka nie została wysłana. */
export async function cancelIntake(fd: FormData) {
  const { db, consignor } = await requireConsignor();
  await db.from("consignor_intakes").update({ status: "cancelled" })
    .eq("id", String(fd.get("intake_id") ?? "")).eq("consignor_id", consignor.id).in("status", ["review", "offer", "to_send"]);
  revalidatePath("/komis");
}
