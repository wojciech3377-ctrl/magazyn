"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSection } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { adjustStock } from "@/lib/stock";
import { appUrl } from "@/lib/app-url";
import { errorMessage } from "@/lib/errors";
import { itemsTable, mailConsignor, refreshIntakeStatus, type IntakeItem } from "@/lib/intake";
import { getCompany } from "@/lib/contracts/settings";
import { mailConfigured, sendMail } from "@/lib/mail";
import { escapeHtml } from "@/lib/contracts/png";
import { contractTotal, formatMoney } from "@/lib/contracts/purchase";

const back = (tab: string, msg: string, ok = true): never =>
  redirect(`/dostawa?zakladka=${tab}&${ok ? "ok" : "blad"}=${encodeURIComponent(msg)}`);
const amount = (v: FormDataEntryValue | null) => {
  const n = Number(String(v ?? "").replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) && n > 0 && n < 1_000_000 ? Math.round(n * 100) / 100 : null;
};

/** Decyzje do zgłoszenia komisanta: Tak / Nie / Oferta (z kwotą) przy każdej rzeczy → e-mail do komisanta. */
export async function decideIntake(fd: FormData) {
  await requireSection("dostawa", "komisanci");
  const db = createAdminClient();
  const intakeId = String(fd.get("intake_id") ?? "");
  const { data: intake } = await db.from("consignor_intakes").select("id, consignor_id, status").eq("id", intakeId).maybeSingle();
  if (!intake || intake.status !== "review") back("akceptacja", "To zgłoszenie jest już obsłużone.", false);
  const { data: items } = await db.from("consignor_intake_items").select("*").eq("intake_id", intakeId).eq("status", "proposed").order("position");
  const plan: { item: IntakeItem; d: string; offer: number | null }[] = [];
  for (const it of (items ?? []) as IntakeItem[]) {
    const d = String(fd.get(`d_${it.id}`) ?? "");
    if (!["yes", "no", "offer"].includes(d)) back("akceptacja", `Wybierz Tak / Nie / Oferta przy: ${it.title} ${it.option ?? ""}`, false);
    const offer = d === "offer" ? amount(fd.get(`o_${it.id}`)) : null;
    if (d === "offer" && !offer) back("akceptacja", `Wpisz kwotę oferty przy: ${it.title} ${it.option ?? ""}`, false);
    plan.push({ item: it, d, offer });
  }
  for (const p of plan) {
    const patch = p.d === "yes" ? { status: "accepted", final_price: p.item.proposed_price } : p.d === "no" ? { status: "rejected" } : { status: "offered", offer_price: p.offer };
    await db.from("consignor_intake_items").update(patch).eq("id", p.item.id).eq("status", "proposed");
  }
  const next = await refreshIntakeStatus(db, intakeId);
  const yes = plan.filter((p) => p.d === "yes");
  const offers = plan.filter((p) => p.d === "offer");
  const no = plan.filter((p) => p.d === "no");
  const parts: string[] = [];
  if (yes.length) parts.push(`<p style="margin:0 0 6px"><b>Przyjmujemy</b> – możesz je wysłać:</p>${itemsTable(yes.map((p) => ({ title: p.item.title, option: p.item.option, price: Number(p.item.proposed_price) })))}`);
  if (offers.length) parts.push(`<p style="margin:0 0 6px"><b>Proponujemy inne kwoty</b> – zaakceptuj albo odmów w panelu:</p>${itemsTable(offers.map((p) => ({ title: p.item.title, option: p.item.option, price: p.offer, note: `Twoja: ${Number(p.item.proposed_price).toFixed(2)} zł` })))}`);
  if (no.length) parts.push(`<p style="margin:0 0 6px">Tych rzeczy nie przyjmiemy:</p>${itemsTable(no.map((p) => ({ title: p.item.title, option: p.item.option, price: Number(p.item.proposed_price) })))}`);
  const tail = next === "to_send" ? "<p>Wyślij paczkę na adres podany w panelu i wpisz tam numer przesyłki.</p>" : next === "offer" ? "<p>Po Twojej odpowiedzi na oferty wyślesz paczkę z przyjętymi rzeczami.</p>" : "";
  const mailed = await mailConsignor(db, intake!.consignor_id as string, next === "closed" ? "Odpowiedź na Twoje zgłoszenie" : "Twoje zgłoszenie – nasza odpowiedź",
    `<p style="margin:0 0 12px">sprawdziliśmy rzeczy, które chcesz nam wysłać.</p>${parts.join("")}${tail}`,
    next === "closed" ? undefined : { href: `${await appUrl()}/komis?zakladka=wyslij`, label: next === "offer" ? "Odpowiedz na ofertę" : "Wpisz numer przesyłki" });
  revalidatePath("/dostawa");
  back("akceptacja", `Zapisano: tak ${yes.length}, oferta ${offers.length}, nie ${no.length}.${mailed ? " Komisant dostał e-mail." : " (E-mail nie wyszedł – brak adresu komisanta albo ustawień poczty.)"}`);
}

/** Paczka od komisanta dotarła: zaznaczone rzeczy trafiają na stan (komis, kwota komisanta), reszta „nie dotarło”. */
export async function receiveIntake(fd: FormData) {
  const { supabase, profile } = await requireSection("dostawa", "komisanci");
  const db = createAdminClient();
  const intakeId = String(fd.get("intake_id") ?? "");
  const { data: intake } = await db.from("consignor_intakes").select("id, consignor_id, location_id, status, location:locations(store_id)").eq("id", intakeId).maybeSingle();
  if (!intake || !["to_send", "sent"].includes(intake.status as string)) back("w-drodze", "Tej paczki nie można już przyjąć.", false);
  const locationId = String(fd.get("location_id") ?? "") || (intake!.location_id as string);
  const { data: loc } = await db.from("locations").select("id, store_id").eq("id", locationId).maybeSingle();
  if (!loc) back("w-drodze", "Wybierz lokalizację.", false);
  const { data: items } = await db.from("consignor_intake_items").select("*").eq("intake_id", intakeId).eq("status", "accepted").order("position");
  const list = (items ?? []) as IntakeItem[];
  const got = list.filter((i) => fd.get(`got_${i.id}`));
  if (!got.length) back("w-drodze", "Zaznacz rzeczy, które dotarły.", false);
  // Rzecz spoza katalogu (nie wybrano produktu) – produkt „nieprzypisany do Shopify”, przypiszesz go później na karcie sztuki.
  let unassigned = 0;
  for (const i of got) {
    let v = i.variant_id ?? (String(fd.get(`v_${i.id}`) ?? "") || null);
    if (!v) {
      const { data: nv, error: ne } = await db.rpc("create_unassigned_variant", { p_title: i.title, p_option: i.option ?? "" });
      if (ne || !nv) back("w-drodze", /create_unassigned_variant|schema cache/i.test(ne?.message ?? "") ? `Wybierz produkt z katalogu dla: ${i.title} ${i.option ?? ""} (rzeczy spoza katalogu wymagają SQL 63).` : `Nie udało się dodać „${i.title}”: ${ne?.message ?? ""}`, false);
      v = nv as string;
      unassigned++;
    }
    i.variant_id = v;
  }
  // Przejęcie paczki (drugi klik / równoległe przyjęcie nic nie zdubluje).
  const { data: claimed } = await db.from("consignor_intakes").update({ status: "received", received_at: new Date().toISOString(), received_by: profile.id })
    .eq("id", intakeId).in("status", ["to_send", "sent"]).select("id");
  if (!claimed?.length) back("w-drodze", "Ta paczka jest już przyjęta.", false);

  let deliveryId: string | null = null;
  const created: { variantId: string; locationId: string; delta: number }[] = [];
  try {
    for (const i of got) {
      const before = deliveryId ? new Set(((await db.from("units").select("id").eq("delivery_id", deliveryId)).data ?? []).map((u) => u.id as string)) : new Set<string>();
      const { data, error } = await supabase.rpc("receive_delivery", {
        p_store_id: loc!.store_id, p_location_id: loc!.id, p_variant_id: i.variant_id, p_quantity: 1, p_status: "in_stock",
        p_owner_type: "consignment", p_consignor_id: intake!.consignor_id, p_purchase_form: i.purchase_form ?? "vat_margin", p_purchase_price: null,
        p_payout_amount: i.final_price, p_contract_id: null, p_identifiers: [], p_shelf: null, p_note: "ze zgłoszenia komisanta", p_delivery_id: deliveryId,
      });
      if (error) throw error;
      deliveryId = data as string;
      const { data: now } = await db.from("units").select("id").eq("delivery_id", deliveryId);
      const unitId = (now ?? []).map((u) => u.id as string).find((id) => !before.has(id)) ?? null;
      await db.from("consignor_intake_items").update({ status: "received", unit_id: unitId, variant_id: i.variant_id }).eq("id", i.id);
      created.push({ variantId: i.variant_id!, locationId: loc!.id, delta: 1 });
    }
  } catch (e) {
    await db.from("consignor_intakes").update({ status: "sent", delivery_id: deliveryId }).eq("id", intakeId);
    back("w-drodze", `Przyjęcie przerwane: ${errorMessage(e)}${deliveryId ? " – część rzeczy jest już w magazynie (zobacz dostawę)." : ""}`, false);
  }
  const missing = list.filter((i) => !got.includes(i));
  if (missing.length) await db.from("consignor_intake_items").update({ status: "missing" }).in("id", missing.map((i) => i.id));
  await db.from("consignor_intakes").update({ delivery_id: deliveryId }).eq("id", intakeId);
  const results = await adjustStock(supabase, created);
  const failed = results.filter((r) => !r.ok);
  await db.from("deliveries").update({
    base_sync_status: failed.length ? "error" : "ok",
    base_sync_error: failed.length ? failed.map((f) => f.message).join("\n") : null,
    base_pending: failed.map(({ variantId, locationId, delta }) => ({ variantId, locationId, delta })),
  }).eq("id", deliveryId!);
  await mailConsignor(db, intake!.consignor_id as string, "Twoja paczka dotarła",
    `<p style="margin:0 0 12px">przyjęliśmy Twoje rzeczy do komisu:</p>${itemsTable(got.map((i) => ({ title: i.title, option: i.option, price: Number(i.final_price) })))}${missing.length ? `<p>Nie znaleźliśmy w paczce: ${missing.map((i) => escapeHtml(`${i.title} ${i.option ?? ""}`)).join(", ")} – skontaktuj się z nami.</p>` : ""}`,
    { href: `${await appUrl()}/komis`, label: "Otwórz panel" });
  revalidatePath("/dostawa");
  revalidatePath("/magazyn");
  redirect(`/dostawa/${deliveryId}${unassigned ? `?ok=${encodeURIComponent(`${unassigned} szt. spoza katalogu ma status „nieprzypisany do Shopify” – przypisz je na karcie sztuki (Magazyn → filtr „Nieprzypisane do Shopify”).`)}` : ""}`);
}

/** Umowa podpisana przez sprzedającego: nasza oferta cenowa (nowe kwoty pozycji) → e-mail z linkiem do akceptacji. */
export async function offerContract(fd: FormData) {
  const { supabase } = await requireSection("dostawa", "komisanci");
  const id = String(fd.get("id") ?? "");
  const { data: c } = await supabase.from("contracts").select("id, status, items, sign_token, seller_email, number, currency, location_id, type").eq("id", id).maybeSingle();
  if (!c || c.status !== "signed" || !c.sign_token) back("akceptacja", "Ofertę można złożyć tylko do podpisanej umowy, która czeka na zatwierdzenie.", false);
  if (c!.type === "invoice") back("akceptacja", "Do faktury nie można wysłać oferty – odrzuć ją i wyślij nowy link z innymi cenami.", false);
  const items = (c!.items ?? []) as { title: string; option: string; qty: number; price: number }[];
  const prices = items.map((it, idx) => amount(fd.get(`p_${idx}`)) ?? Number(it.price));
  if (prices.every((p, idx) => p === Number(items[idx].price))) back("akceptacja", "Zmień kwotę co najmniej jednej pozycji (albo kliknij Tak).", false);
  const locationId = String(fd.get("location_id") ?? "") || c!.location_id || null;
  const note = String(fd.get("note") ?? "").trim().slice(0, 500) || null;
  const { data: upd } = await supabase.from("contracts").update({
    status: "offer", offer: { prices, previous: items.map((i) => Number(i.price)), note, sent_at: new Date().toISOString(), location_id: locationId },
    sign_expires_at: new Date(Date.now() + 14 * 86400_000).toISOString(),
  }).eq("id", id).eq("status", "signed").select("id");
  if (!upd?.length) back("akceptacja", "Umowa zmieniła status – odśwież stronę.", false);
  const link = `${await appUrl()}/podpis/${c!.sign_token}/oferta`;
  let mailed = false;
  if (c!.seller_email && (await mailConfigured())) {
    try {
      const company = await getCompany(supabase);
      const total = contractTotal(items.map((it, idx) => ({ ...it, qty: Number(it.qty ?? 1), price: prices[idx] })));
      await sendMail(c!.seller_email, `Umowa nr ${c!.number}: nasza propozycja ceny – ${company.name}`,
        `<p>Dzień dobry,</p><p>dziękujemy za podpisanie umowy nr ${c!.number}. Proponujemy inne ceny:</p>` +
        `<table style="border-collapse:collapse">${items.map((it, idx) => `<tr><td style="padding:3px 10px 3px 0">${escapeHtml(`${it.title} ${it.option ?? ""}`)}</td><td style="padding:3px 10px 3px 0;color:#5b6878"><s>${escapeHtml(formatMoney(Number(it.price), c!.currency ?? "PLN"))}</s></td><td style="padding:3px 0"><b>${escapeHtml(formatMoney(prices[idx], c!.currency ?? "PLN"))}</b></td></tr>`).join("")}</table>` +
        `<p>Razem: <b>${escapeHtml(formatMoney(total, c!.currency ?? "PLN"))}</b></p>${note ? `<p>${escapeHtml(note)}</p>` : ""}` +
        `<p>Zaakceptuj albo odrzuć propozycję tutaj (link ważny 14 dni):</p><p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p><p>${escapeHtml(company.name)}</p>`);
      mailed = true;
    } catch (e) {
      back("akceptacja", `Oferta zapisana, ale e-mail nie wyszedł (${errorMessage(e)}). Wyślij sprzedającemu link: ${link}`, false);
    }
  }
  revalidatePath("/dostawa");
  back("akceptacja", mailed ? "Oferta wysłana e-mailem do sprzedającego." : `Oferta zapisana. Sprzedający nie podał e-maila – wyślij mu link SMS-em: ${link}`);
}

/** Towar z umowy („w drodze”) dotarł – na stan albo od razu do zamówienia. */
export async function receiveContractUnits(fd: FormData) {
  const { supabase } = await requireSection("dostawa", "komisanci");
  const contractId = String(fd.get("contract_id") ?? "");
  const { data: units } = await supabase.from("units").select("id").eq("contract_id", contractId).eq("status", "in_transit");
  const picked = new Set(fd.getAll("unit").map(String));
  const ids = (units ?? []).map((u) => u.id as string).filter((id) => picked.has(id));
  if (!ids.length) back("w-drodze", "Zaznacz sztuki, które dotarły (albo ta umowa nie ma już towaru „w drodze”).", false);
  const { data: received, error } = await supabase.rpc("receive_in_transit", { p_unit_ids: ids });
  if (error) back("w-drodze", error.message, false);
  const rows = (received ?? []) as { unit_id: string; variant_id: string; location_id: string; to_status: string }[];
  const toStock = rows.filter((r) => r.to_status === "in_stock");
  const results = await adjustStock(supabase, toStock.map((u) => ({ variantId: u.variant_id, locationId: u.location_id, delta: 1 })));
  revalidatePath("/dostawa");
  revalidatePath("/magazyn");
  const failed = results.filter((r) => !r.ok);
  back("w-drodze", `Przyjęto ${rows.length} szt.: na stan ${toStock.length}${rows.length - toStock.length ? `, do zamówień ${rows.length - toStock.length}` : ""}.${failed.length ? ` Shopify: ${failed.map((f) => f.message).join("; ")}` : ""}`, !failed.length);
}
