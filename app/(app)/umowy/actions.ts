"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirect } from "next/navigation";
import { requireAdmin, requireSection } from "@/lib/auth";
import { parseAmount, uploadedFile } from "@/lib/contracts/upload";
import { fillContractNumber } from "@/lib/contracts/docnumber";
import { errorMessage } from "@/lib/errors";

function codes(text: string) {
  return text.split(/[\s,;]+/).map((s) => s.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "")).filter(Boolean);
}

async function attachByCodes(supabase: Awaited<ReturnType<typeof requireSection>>["supabase"], contractId: string, text: string) {
  const list = codes(text);
  if (!list.length) return { attached: 0, missing: [] as string[] };
  const { data: units } = await supabase.from("units").select("id, code, identifier").or(
    `code.in.(${list.join(",")}),identifier.in.(${list.join(",")})`,
  );
  const found = units ?? [];
  if (found.length) {
    await supabase.from("units").update({ contract_id: contractId }).in("id", found.map((u) => u.id));
    await supabase.from("unit_events").insert(found.map((u) => ({ unit_id: u.id, type: "contract", data: { contract_id: contractId } })));
  }
  const hit = new Set(found.flatMap((u) => [u.code, (u.identifier ?? "").toUpperCase()]));
  return { attached: found.length, missing: list.filter((c) => !hit.has(c)) };
}

export async function createContract(_: unknown, formData: FormData): Promise<{ error?: string }> {
  const { supabase } = await requireSection("umowy", "dostawa");
  let id: string;
  let note = "";
  try {
    const counterparty = String(formData.get("counterparty") ?? "").trim();
    if (!counterparty) return { error: "Podaj, z kim jest umowa." };
    const type = String(formData.get("type") ?? "purchase");
    const file = uploadedFile(formData);
    // Rzeczy z katalogu (jeszcze bez sztuki w magazynie) – zapisane w umowie, sztuki przypiszesz później.
    let catalogItems: { title: string; option: string; qty: number; price: number; variant_id: string }[] = [];
    try {
      const raw = JSON.parse(String(formData.get("catalog_items") ?? "[]")) as { variant_id?: string }[];
      const vids = [...new Set(raw.map((r) => String(r.variant_id ?? "")).filter((v) => /^[0-9a-f-]{36}$/.test(v)))].slice(0, 50);
      const { data: vs } = vids.length ? await supabase.from("variants").select("id, option, product:products(title)").in("id", vids) : { data: [] };
      catalogItems = raw.map((r) => (vs ?? []).find((v) => v.id === r.variant_id)).filter((v): v is NonNullable<typeof v> => !!v)
        .map((v) => ({ title: (v.product as unknown as { title: string }).title, option: v.option as string, qty: 1, price: 0, variant_id: v.id as string }));
    } catch {
      catalogItems = [];
    }
    const docNumber = String(formData.get("doc_number") ?? "").trim().slice(0, 60) || null;
    const { data, error } = await supabase.from("contracts").insert({
      type,
      counterparty,
      doc_number: docNumber,
      ...(catalogItems.length ? { items: catalogItems } : {}),
      consignor_id: type === "consignment" ? String(formData.get("consignor_id") ?? "") || null : null,
      contract_date: String(formData.get("contract_date") ?? "") || null,
      amount: parseAmount(formData.get("amount")),
      currency: ["PLN", "EUR"].includes(String(formData.get("currency"))) ? String(formData.get("currency")) : null,
      notes: String(formData.get("notes") ?? "").trim() || null,
      file_path: file?.path ?? null,
      file_name: file?.name ?? null,
    }).select("id").single();
    if (error) throw error;
    id = data.id;
    // Numer nie wpisany → odczyt z pliku PDF (klucz serwera – plik w prywatnym magazynie).
    if (!docNumber) await fillContractNumber(createAdminClient(), id);
    const saleId = String(formData.get("sale_id") ?? "");
    if (saleId) {
      const { error: attachErr } = await supabase.rpc("attach_sale_unit", { p_sale_id: saleId, p_contract_id: id, p_purchase_price: parseAmount(formData.get("amount")), p_variant_id: String(formData.get("variant_id") ?? "") || null });
      if (attachErr) note = `?blad=${encodeURIComponent(`Umowa zapisana, ale nie przypięta do sprzedaży: ${attachErr.message}`)}`;
    }
    const r = await attachByCodes(supabase, id, String(formData.get("units") ?? ""));
    if (r.missing.length) note = `?blad=${encodeURIComponent(`Nie znaleziono sztuk: ${r.missing.join(", ")}`)}`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String((e as { message?: string }).message ?? e) };
  }
  revalidatePath("/umowy");
  revalidatePath("/magazyn");
  const returnTo = String(formData.get("returnTo") ?? "");
  if (returnTo.startsWith("/") && !returnTo.startsWith("//") && !note) {
    redirect(`${returnTo}${returnTo.includes("?") ? "&" : "?"}ok=${encodeURIComponent("Umowa zapisana i przypięta.")}`);
  }
  redirect(`/umowy/${id}${note}`);
}

export async function attachUnits(formData: FormData) {
  const { supabase } = await requireSection("umowy", "dostawa");
  const id = String(formData.get("id"));
  const r = await attachByCodes(supabase, id, String(formData.get("units") ?? ""));
  revalidatePath(`/umowy/${id}`);
  const msg = r.missing.length ? `blad=${encodeURIComponent(`Przypięto ${r.attached}. Nie znaleziono: ${r.missing.join(", ")}`)}` : `ok=${encodeURIComponent(`Przypięto ${r.attached} szt.`)}`;
  redirect(`/umowy/${id}?${msg}`);
}

/** Odpięcie umowy od rzeczy. Gdy przy umowie nie zostaje żadna rzecz, wraca do niewykorzystanych umów. */
export async function detachUnit(formData: FormData) {
  const { supabase } = await requireSection("umowy", "dostawa");
  const id = String(formData.get("id"));
  const unitId = String(formData.get("unit_id"));
  const b = String(formData.get("back") ?? "");
  const target = b.startsWith("/") && !b.startsWith("//") ? b : `/umowy/${id}`;
  const { data: done } = await supabase.from("units").update({ contract_id: null }).eq("id", unitId).eq("contract_id", id).select("id, code");
  if (done?.length) {
    await supabase.from("unit_events").insert({ unit_id: unitId, type: "contract", data: { contract_id: null, detached_from: id } });
    const { count } = await supabase.from("units").select("id", { count: "exact", head: true }).eq("contract_id", id);
    // Bez rzeczy umowa nie jest już przypięta do sprzedaży – można ją przypisać gdzie indziej.
    if (!count) await supabase.from("contracts").update({ sale_id: null }).eq("id", id).not("status", "in", "(sent,signed,offer)");
  }
  revalidatePath(`/umowy/${id}`);
  revalidatePath("/umowy");
  revalidatePath("/sprzedaz");
  revalidatePath("/magazyn");
  redirect(`${target}${target.includes("?") ? "&" : "?"}ok=${encodeURIComponent(done?.length ? `Umowa odpięta od ${done[0].code} – jest znowu do przypisania.` : "Ta rzecz nie ma już tej umowy.")}`);
}

export async function replaceFile(formData: FormData) {
  const { supabase } = await requireSection("umowy", "dostawa");
  const id = String(formData.get("id"));
  let msg = "ok=" + encodeURIComponent("Plik zapisany.");
  try {
    const file = uploadedFile(formData);
    if (!file) msg = "blad=" + encodeURIComponent("Wybierz plik.");
    else {
      const { data: saved, error } = await supabase.from("contracts").update({ file_path: file.path, file_name: file.name, doc_number: null }).eq("id", id).select("id");
      if (error) throw error;
      if (!saved?.length) throw new Error("Nie udało się zapisać pliku w tej umowie (brak uprawnień albo umowa została usunięta).");
      await fillContractNumber(supabase, id);
    }
  } catch (e) {
    msg = "blad=" + encodeURIComponent(errorMessage(e));
  }
  revalidatePath(`/umowy/${id}`);
  redirect(`/umowy/${id}?${msg}`);
}

export async function deleteContract(formData: FormData) {
  const { supabase } = await requireAdmin();
  const id = String(formData.get("id"));
  const { data: c } = await supabase.from("contracts").select("file_path").eq("id", id).single();
  await supabase.from("units").update({ contract_id: null }).eq("contract_id", id);
  const { error } = await supabase.from("contracts").delete().eq("id", id);
  if (error) redirect(`/umowy/${id}?blad=${encodeURIComponent(error.message)}`);
  if (c?.file_path) await supabase.storage.from("contracts").remove([c.file_path]);
  revalidatePath("/umowy");
  redirect("/umowy");
}

/** Link do podpisu e-mailem (SMTP z Vercel). */
export async function sendSigningEmail(formData: FormData) {
  const { supabase } = await requireSection("umowy", "dostawa");
  const id = String(formData.get("id"));
  const to = String(formData.get("email") ?? "").trim().toLowerCase();
  const { data: contract } = await supabase.from("contracts").select("status, sign_token").eq("id", id).single();
  const { appUrl } = await import("@/lib/app-url");
  const link = contract?.sign_token ? `${await appUrl()}/podpis/${contract.sign_token}` : "";
  const { mailConfigured, sendMail } = await import("@/lib/mail");
  const { getCompany } = await import("@/lib/contracts/settings");
  let msg = "";
  if (!to || !/^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/.test(to)) msg = "blad=" + encodeURIComponent("Wpisz poprawny e-mail sprzedającego.");
  else if (contract?.status !== "sent" || !link) msg = "blad=" + encodeURIComponent("Ta umowa nie czeka na podpis.");
  else if (!(await mailConfigured())) msg = "blad=" + encodeURIComponent("Wysyłka e-maili nie jest ustawiona (Ustawienia → Faktury i KSeF). Skopiuj link i wyślij go sam.");
  else {
    try {
      const company = await getCompany(supabase);
      const { escapeHtml } = await import("@/lib/contracts/png");
      await sendMail(to, `Umowa kupna do podpisu – ${company.name}`,
        `<p>Dzień dobry,</p><p>przygotowaliśmy umowę kupna. Uzupełnij swoje dane i podpisz ją tutaj:</p><p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p><p>Link jest ważny 14 dni.</p><p>${escapeHtml(company.name)}</p>`);
      await supabase.from("contracts").update({ seller_email: to }).eq("id", id);
      msg = "ok=" + encodeURIComponent(`Wysłano link na ${to}.`);
    } catch (e) {
      msg = "blad=" + encodeURIComponent(errorMessage(e));
    }
  }
  redirect(`/umowy/${id}?${msg}`);
}

export async function cancelContract(formData: FormData) {
  const { supabase } = await requireSection("umowy", "dostawa");
  const id = String(formData.get("id"));
  // Warunek na status: jeśli sprzedający właśnie podpisał, anulowanie nie przejdzie.
  const { data: cancelled } = await supabase.from("contracts").update({ status: "cancelled" }).eq("id", id).eq("status", "sent").select("id");
  if (!cancelled?.length) redirect(`/umowy/${id}?blad=${encodeURIComponent("Anulować można tylko niepodpisaną umowę.")}`);
  await supabase.from("units").update({ contract_id: null }).eq("contract_id", id);
  revalidatePath(`/umowy/${id}`);
  redirect(`/umowy/${id}?ok=${encodeURIComponent("Umowa anulowana, link nie działa.")}`);
}

/** Umowa z ogólnego linku: przypisanie pozycji do katalogu i utworzenie sztuk „w drodze”. */
export async function assignGeneralItems(_: unknown, formData: FormData): Promise<{ error?: string }> {
  const { supabase } = await requireSection("umowy", "dostawa");
  const id = String(formData.get("id"));
  const variants = JSON.parse(String(formData.get("variants") ?? "[]")) as (string | null)[];
  const locationId = String(formData.get("location_id") ?? "");
  if (!locationId) return { error: "Wybierz lokalizację." };
  const { data: c } = await supabase.from("contracts").select("items, units_created_at, status").eq("id", id).single();
  if (!c) return { error: "Nie ma takiej umowy." };
  if (c.status !== "accepted") return { error: "Najpierw zatwierdź umowę." };
  if (c.units_created_at) return { error: "Sztuki z tej umowy już są w magazynie." };
  const items = (c.items ?? []) as Record<string, unknown>[];
  if (variants.length !== items.length || variants.some((v) => !v)) return { error: "Przypisz produkt z katalogu do każdej pozycji." };
  const updated = items.map((it, i) => ({ ...it, variant_id: variants[i] }));
  const { error } = await supabase.from("contracts").update({ items: updated, location_id: locationId }).eq("id", id);
  if (error) return { error: error.message };
  const fin = await supabase.rpc("finalize_contract", { p_contract_id: id });
  if (fin.error) return { error: fin.error.message };
  revalidatePath(`/umowy/${id}`);
  redirect(`/umowy/${id}?ok=${encodeURIComponent(`Utworzono ${fin.data.created_units} szt. „w drodze”. Po dotarciu przyjmij je w Magazynie.`)}`);
}

/** Ponowne utworzenie sztuk z podpisanej umowy, gdy automatyczny krok po podpisie się nie udał. */
export async function retryFinalize(formData: FormData) {
  const { supabase } = await requireSection("umowy", "dostawa");
  const id = String(formData.get("id"));
  const { data, error } = await supabase.rpc("finalize_contract", { p_contract_id: id });
  revalidatePath(`/umowy/${id}`);
  redirect(`/umowy/${id}?${error ? `blad=${encodeURIComponent(error.message)}` : `ok=${encodeURIComponent(`Gotowe: ${data.created_units} nowych sztuk „w drodze”.`)}`}`);
}

/** Zatwierdzenie umowy podpisanej przez sprzedającego: nasz podpis, PDF dla sprzedającego, sztuki „w drodze”. */
/** Powrót po decyzji: na stronę umowy albo do Przyjęcia dostawy (gdy decyzja zapadła tam). */
function decisionTarget(formData: FormData, id: string) {
  const b = String(formData.get("back") ?? "");
  return b.startsWith("/dostawa") && !b.startsWith("//") ? b : `/umowy/${id}`;
}
const withMsg = (url: string, key: "ok" | "blad", msg: string) => `${url}${url.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(msg)}`;

export async function acceptContract(formData: FormData) {
  const { supabase, profile } = await requireSection("umowy", "dostawa");
  const id = String(formData.get("id"));
  const target = decisionTarget(formData, id);
  const locationId = String(formData.get("location_id") ?? "") || null;
  const { data: accepted } = await supabase.from("contracts")
    .update({ status: "accepted", accepted_at: new Date().toISOString(), accepted_by: profile.id, ...(locationId ? { location_id: locationId } : {}) })
    .eq("id", id).eq("status", "signed").select("id, source, items");
  if (!accepted?.length) redirect(withMsg(target, "blad", "Zatwierdzić można tylko umowę podpisaną przez sprzedającego."));

  // Każda rzecz dostaje osobną umowę z własnym numerem (bez migracji 0040 – jedna umowa jak dotąd).
  const split = await (await import("@/lib/supabase/admin")).createAdminClient().rpc("split_contract", { p_contract_id: id });
  const ids = (split.error ? [id] : (split.data as string[] | null) ?? [id]);
  const msgs: string[] = [ids.length > 1 ? `Umowa zatwierdzona i podzielona na ${ids.length} umowy – osobna dla każdej rzeczy.` : "Umowa zatwierdzona."];

  // Umowa z ogólnego linku czeka jeszcze na przypisanie pozycji do katalogu; pozostałe od razu tworzą sztuki.
  const { data: group } = await supabase.from("contracts").select("id, number, items").in("id", ids);
  let created = 0;
  let unlinked = false;
  const errors: string[] = [];
  for (const g of group ?? []) {
    const items = (g.items ?? []) as { unit_id?: string; variant_id?: string }[];
    if (items.every((i) => i.unit_id || i.variant_id)) {
      const fin = await supabase.rpc("finalize_contract", { p_contract_id: g.id });
      if (fin.error) errors.push(`Sztuki (nr ${g.number}): ${fin.error.message}`);
      else created += Number(fin.data?.created_units ?? 0);
    } else unlinked = true;
  }
  if (created) msgs.push(`${created} szt. „w drodze”.`);
  if (unlinked) msgs.push("Przypisz pozycje do katalogu, żeby utworzyć sztuki.");
  msgs.push(...errors);

  const { deliverAcceptedContract } = await import("@/lib/contracts/store");
  let emailed = 0;
  let pdfError: string | undefined;
  for (const cid of ids) {
    const d = await deliverAcceptedContract(cid);
    if (d.error) pdfError = d.error;
    else if (d.emailed) emailed++;
  }
  const d = { error: pdfError };
  if (d.error) msgs.push(`PDF: ${d.error}`);
  else msgs.push(emailed ? `Sprzedający dostał ${emailed > 1 ? `${emailed} umowy` : "umowę"} e-mailem.` : "Sprzedający pobierze umowy ze swojego linku.");
  revalidatePath(`/umowy/${id}`);
  revalidatePath("/dostawa");
  redirect(withMsg(target, d.error ? "blad" : "ok", msgs.join(" ")));
}

export async function rejectContract(formData: FormData) {
  const { supabase } = await requireSection("umowy", "dostawa");
  const id = String(formData.get("id"));
  const target = decisionTarget(formData, id);
  const { data: rejected } = await supabase.from("contracts").update({ status: "rejected" }).eq("id", id).in("status", ["signed", "offer"]).select("id");
  if (!rejected?.length) redirect(withMsg(target, "blad", "Odrzucić można tylko umowę czekającą na zatwierdzenie."));
  await supabase.from("units").update({ contract_id: null }).eq("contract_id", id);
  revalidatePath(`/umowy/${id}`);
  revalidatePath("/dostawa");
  redirect(withMsg(target, "ok", "Umowa odrzucona."));
}

/** Oznaczenie zapłaty sprzedającemu (przelew wysłany / gotówka wypłacona) → zakładka „Gotowe”. */
export async function markPaid(formData: FormData) {
  const { supabase, profile } = await requireSection("umowy", "dostawa");
  const id = String(formData.get("id"));
  const undo = formData.get("undo") === "1";
  const { data } = await supabase.from("contracts")
    .update(undo ? { paid_at: null, paid_by: null } : { paid_at: new Date().toISOString(), paid_by: profile.id })
    .eq("id", id).eq("status", "accepted").select("id");
  const back = String(formData.get("back") ?? "") || `/umowy/${id}`;
  revalidatePath("/umowy");
  if (!data?.length) redirect(`${back}${back.includes("?") ? "&" : "?"}blad=${encodeURIComponent("Opłacić można tylko zaakceptowaną umowę.")}`);
  redirect(`${back}${back.includes("?") ? "&" : "?"}ok=${encodeURIComponent(undo ? "Cofnięto oznaczenie zapłaty." : "Umowa opłacona – przeniesiona do Gotowe.")}`);
}

/** Numer umowy z dokumentu i waluta (do JPK). */
export async function updateContractMeta(formData: FormData) {
  const { supabase } = await requireSection("umowy", "dostawa");
  const id = String(formData.get("id"));
  const currency = String(formData.get("currency") ?? "");
  const { error } = await supabase.from("contracts").update({
    doc_number: String(formData.get("doc_number") ?? "").trim().slice(0, 60) || null,
    ...(currency ? { currency: ["PLN", "EUR"].includes(currency) ? currency : null } : {}),
  }).eq("id", id);
  revalidatePath(`/umowy/${id}`);
  redirect(`/umowy/${id}?${error ? "blad" : "ok"}=${encodeURIComponent(error ? error.message : "Zapisano.")}`);
}

/** Umowa bez rzeczy → sztuka z magazynu (albo sprzedana sztuka) bez umowy. */
export async function assignContractToUnit(formData: FormData) {
  const { supabase } = await requireSection("umowy", "dostawa");
  const contractId = String(formData.get("contract_id") ?? "");
  const unitId = String(formData.get("unit_id") ?? "");
  const back = `/umowy/${contractId}/przypisz`;
  const { data: c } = await supabase.from("contracts").select("id, amount, status").eq("id", contractId).maybeSingle();
  if (!c || ["cancelled", "rejected", "sent"].includes(c.status as string)) redirect(`${back}?blad=${encodeURIComponent("Ta umowa jest anulowana, czeka na podpis albo nie istnieje.")}`);
  const { count: already } = await supabase.from("units").select("id", { count: "exact", head: true }).eq("contract_id", contractId);
  const patch: Record<string, unknown> = { contract_id: contractId };
  const { data: u } = await supabase.from("units").select("id, code, purchase_price, owner_type, status").eq("id", unitId).maybeSingle();
  if (!u || u.owner_type !== "own" || !["in_stock", "reserved", "in_transit", "sold", "shipped"].includes(u.status as string)) redirect(`${back}?blad=${encodeURIComponent("Tej sztuki nie można powiązać z umową (komis, wycofana albo oddana).")}`);
  // Pierwsza rzecz do umowy: cena zakupu = kwota umowy (jeśli sztuka jej nie ma).
  if (!already && u!.purchase_price === null && c!.amount !== null && u!.owner_type === "own") patch.purchase_price = c!.amount;
  const { data: updated, error } = await supabase.from("units").update(patch).eq("id", unitId).is("contract_id", null).select("id");
  if (error || !updated?.length) redirect(`${back}?blad=${encodeURIComponent(error?.message ?? "Ta sztuka ma już umowę (1 umowa na przedmiot).")}`);
  await supabase.from("unit_events").insert({ unit_id: unitId, type: "contract", data: { contract_id: contractId, note: "umowa przypisana z listy umów bez rzeczy" } });
  revalidatePath("/umowy");
  revalidatePath("/magazyn");
  redirect(`/umowy/${contractId}?ok=${encodeURIComponent(`Umowa przypisana do sztuki ${u!.code}.`)}`);
}

/** Umowa bez rzeczy → sprzedana pozycja zamówienia (linia sprzedaży powstaje w razie potrzeby). */
export async function assignContractToPiece(formData: FormData) {
  const { supabase } = await requireSection("umowy", "dostawa");
  const contractId = String(formData.get("contract_id") ?? "");
  const back = `/umowy/${contractId}/przypisz?zrodlo=sprzedaz`;
  const fail = (m: string) => redirect(`${back}&blad=${encodeURIComponent(m)}`);
  const { parsePieceRef } = await import("@/lib/orders/pieces");
  const ref = parsePieceRef(String(formData.get("ref") ?? ""));
  if (!ref) return fail("Nie rozpoznałem pozycji zamówienia.");
  const { data: c } = await supabase.from("contracts").select("id, amount, status").eq("id", contractId).maybeSingle();
  if (!c || ["cancelled", "rejected", "sent"].includes(c.status as string)) return fail("Ta umowa jest anulowana, czeka na podpis albo nie istnieje.");
  const { data: saleId, error } = await supabase.rpc("ensure_order_line_sale", { p_order_id: ref.orderId, p_line_id: ref.lineId, p_index: ref.n });
  if (error || !saleId) return fail(error?.message ?? "Nie udało się przygotować sprzedaży.");
  const { data: sale } = await supabase.from("sales").select("id, unit:units(id, contract_id)").eq("id", saleId as string).single();
  const unit = sale?.unit as unknown as { id: string; contract_id: string | null } | null;
  if (unit) {
    if (unit.contract_id) return fail("Ten przedmiot ma już umowę (1 umowa na przedmiot).");
    const { data: upd, error: e } = await supabase.from("units").update({ contract_id: contractId }).eq("id", unit.id).is("contract_id", null).select("id");
    if (e) return fail(e.message);
    if (!upd?.length) return fail("Ten przedmiot ma już umowę (1 umowa na przedmiot).");
    await supabase.from("unit_events").insert({ unit_id: unit.id, type: "contract", data: { contract_id: contractId, sale_id: saleId } });
  } else {
    const { error: e } = await supabase.rpc("attach_sale_unit", { p_sale_id: saleId, p_contract_id: contractId, p_purchase_price: c.amount ?? null, p_variant_id: null });
    if (e) return fail(e.message);
  }
  revalidatePath("/umowy");
  revalidatePath("/sprzedaz");
  redirect(`/umowy/${contractId}?ok=${encodeURIComponent("Umowa przypisana do sprzedanego przedmiotu.")}`);
}

/** Faktura wgrana przez komisanta: zatwierdzenie albo odrzucenie (wtedy komisant może wgrać nową). */
export async function decideConsignorInvoice(formData: FormData) {
  const { supabase, profile } = await requireSection("umowy", "dostawa");
  const id = String(formData.get("id"));
  const accept = formData.get("decision") === "accept";
  const note = String(formData.get("reason") ?? "").trim().slice(0, 300);
  const { data: done } = await supabase.from("contracts")
    .update(accept ? { status: "accepted", accepted_at: new Date().toISOString(), accepted_by: profile.id } : { status: "rejected", notes: note ? `Odrzucona: ${note}` : "Odrzucona" })
    .eq("id", id).eq("status", "signed").eq("source", "consignor_invoice").select("id, doc_number, consignor:consignors(name, email)");
  if (!done?.length) redirect(`/umowy/${id}?blad=${encodeURIComponent("Ta faktura nie czeka na zatwierdzenie.")}`);
  if (!accept) await supabase.from("units").update({ contract_id: null }).eq("contract_id", id);
  const consignor = done[0].consignor as unknown as { name: string; email: string | null } | null;
  let mailNote = "";
  try {
    const { mailConfigured, sendMail } = await import("@/lib/mail");
    if (consignor?.email && (await mailConfigured())) {
      const { getCompany } = await import("@/lib/contracts/settings");
      const { escapeHtml } = await import("@/lib/contracts/png");
      const { appUrl } = await import("@/lib/app-url");
      const company = await getCompany(supabase);
      const num = escapeHtml(String(done[0].doc_number ?? ""));
      await sendMail(consignor.email, accept ? `Faktura ${done[0].doc_number ?? ""} zatwierdzona – ${company.name}` : `Faktura ${done[0].doc_number ?? ""} odrzucona – ${company.name}`,
        accept
          ? `<p>Dzień dobry,</p><p>zatwierdziliśmy Twoją fakturę <b>${num}</b>. Kwotę do wypłaty widzisz w panelu komisanta.</p><p>${escapeHtml(company.name)}</p>`
          : `<p>Dzień dobry,</p><p>nie możemy przyjąć faktury <b>${num}</b>${note ? `: ${escapeHtml(note)}` : ""}.</p><p>Wgraj poprawioną fakturę albo wypełnij umowę w panelu komisanta: <a href="${escapeHtml(`${await appUrl()}/komis?zakladka=sprzedane`)}">otwórz panel</a>.</p><p>${escapeHtml(company.name)}</p>`);
      mailNote = " Komisant dostał e-mail.";
    }
  } catch (e) {
    mailNote = ` E-mail do komisanta nie wyszedł: ${errorMessage(e)}`;
  }
  revalidatePath(`/umowy/${id}`);
  revalidatePath("/umowy");
  redirect(`/umowy/${id}?ok=${encodeURIComponent((accept ? "Faktura zatwierdzona." : "Faktura odrzucona – komisant może wgrać nową.") + mailNote)}`);
}

export type NoContractUnit = { id: string; code: string; identifier: string | null; title: string; option: string; status: string; store: string | null; image: string | null };

/** Rzeczy w sklepie bez umowy (na stanie, zarezerwowane, w drodze) – do wyboru przy nowej umowie. */
export async function searchUnitsWithoutContract(q: string): Promise<NoContractUnit[]> {
  const { supabase } = await requireSection("umowy", "dostawa");
  const text = q.trim().replace(/[,()*%\\]/g, " ").trim();
  let query = supabase.from("units_list").select("id, code, identifier, title, option, status, store_name, image_url")
    .is("contract_id", null).in("status", ["in_stock", "reserved", "in_transit"]).order("received_at", { ascending: false }).limit(30);
  if (text.length >= 2) {
    for (const w of text.split(/\s+/).slice(0, 4)) {
      query = query.or(`title.ilike.%${w}%,code.ilike.%${w}%,identifier.ilike.%${w}%,style_sku.ilike.%${w}%,option.ilike.${w}`);
    }
  }
  const { data } = await query;
  return (data ?? []).map((u) => ({
    id: u.id as string, code: u.code as string, identifier: (u.identifier as string | null) ?? null, title: u.title as string, option: u.option as string,
    status: u.status as string, store: (u.store_name as string | null) ?? null, image: (u.image_url as string | null) ?? null,
  }));
}
