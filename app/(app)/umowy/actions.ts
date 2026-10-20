"use server";

import { contractTakenError } from "@/lib/contracts/free";
import { searchWords, wordsOr } from "@/lib/search";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirect } from "next/navigation";
import { requireAdmin, requireSection } from "@/lib/auth";
import { parseAmount, uploadedFile } from "@/lib/contracts/upload";
import { fillContractNumber } from "@/lib/contracts/docnumber";
import { errorMessage } from "@/lib/errors";
import { reusedProducts } from "@/lib/queries/reused";
import { inheritContractPrice, priceMessage, type PriceResult } from "@/lib/contracts/inherit-price";

function codes(text: string) {
  return text.split(/[\s,;]+/).map((s) => s.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "")).filter(Boolean);
}

async function attachByCodes(supabase: Awaited<ReturnType<typeof requireSection>>["supabase"], contractId: string, text: string) {
  const list = codes(text);
  const noPrice: PriceResult = { updated: [], problems: [], notes: [] };
  if (!list.length) return { attached: 0, missing: [] as string[], price: noPrice };
  const { data: units } = await supabase.from("units").select("id, code, identifier").or(
    `code.in.(${list.join(",")}),identifier.in.(${list.join(",")})`,
  );
  const found = units ?? [];
  if (found.length) {
    // Forma VAT umowy niezgodna z którąś sztuką – baza odrzuca całość z opisem (nic nie zostaje przypięte).
    const { error } = await supabase.from("units").update({ contract_id: contractId }).in("id", found.map((u) => u.id));
    if (error) throw new Error(error.message);
    await supabase.from("unit_events").insert(found.map((u) => ({ unit_id: u.id, type: "contract", data: { contract_id: contractId } })));
  }
  const hit = new Set(found.flatMap((u) => [u.code, (u.identifier ?? "").toUpperCase()]));
  // Kwota zakupu z umowy (albo opis, dlaczego się różni).
  const price = found.length ? await inheritContractPrice(supabase, contractId, found.map((u) => u.id as string)) : noPrice;
  return { attached: found.length, missing: list.filter((c) => !hit.has(c)), price };
}

export async function createContract(_: unknown, formData: FormData): Promise<{ error?: string }> {
  const { supabase } = await requireSection("umowy", "dostawa");
  let id: string;
  let note = "";
  let okNote = "";
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
    // Przedmioty faktury wpisane ręcznie (opis – bez sztuk i bez wpływu na kwoty zakupu).
    const manualItems = parseManualItems(formData.get("manual_items"));
    // Rzeczy wpisane ręcznie / spoza katalogu → od razu sztuki na stanie („nieprzypisane do Shopify”).
    const stockLoc = formData.get("to_stock") === "1" && !formData.get("sale_id") ? String(formData.get("stock_location_id") ?? "") : "";
    if (formData.get("to_stock") === "1" && !formData.get("sale_id") && manualItems.length && !stockLoc) return { error: "Wybierz lokalizację, na którą trafią rzeczy (albo odznacz „dodaj do magazynu”)." };
    const docNumber = String(formData.get("doc_number") ?? "").trim().slice(0, 60) || null;
    const perItem = formData.get("amount_per_item") === "1";
    const vatForm = ["vat_margin", "vat_23"].includes(String(formData.get("vat_form"))) ? String(formData.get("vat_form")) : null;
    const payload = {
      ...(perItem ? { amount_per_item: true } : {}),
      ...(vatForm ? { vat_form: vatForm } : {}),
      type,
      counterparty,
      doc_number: docNumber,
      consignor_id: type === "consignment" ? String(formData.get("consignor_id") ?? "") || null : null,
      contract_date: String(formData.get("contract_date") ?? "") || null,
      amount: parseAmount(formData.get("amount")),
      currency: ["PLN", "EUR"].includes(String(formData.get("currency"))) ? String(formData.get("currency")) : null,
      notes: String(formData.get("notes") ?? "").trim() || null,
      file_path: file?.path ?? null,
      file_name: file?.name ?? null,
    };
    const { data, error } = await supabase.from("contracts").insert({
      ...payload,
      ...(catalogItems.length || manualItems.length ? { items: [...catalogItems, ...manualItems] } : {}),
    }).select("id").single();
    if (error && /amount_per_item/.test(error.message)) throw new Error("Aby zapisać „kwota za każdą rzecz”, uruchom w Supabase (SQL Editor) plik 0055_contract_amount_per_item.sql.");
    if (error && /vat_form/.test(error.message)) throw new Error("Aby zapisać formę VAT umowy, uruchom w Supabase (SQL Editor) plik 0056_contract_vat_form.sql.");
    if (error) throw error;
    id = data.id;
    // Numer nie wpisany → odczyt z pliku PDF (klucz serwera – plik w prywatnym magazynie).
    if (!docNumber) await fillContractNumber(createAdminClient(), id);
    let stockErr = "";
    if (stockLoc && (catalogItems.length || manualItems.length)) {
      const { stockContractItems } = await import("@/lib/contracts/stock-items");
      const r = await stockContractItems(supabase, id, [...catalogItems, ...manualItems], stockLoc, formData.get("stock_status") === "in_stock" ? "in_stock" : "in_transit").catch((e: unknown) => ({ items: null, created: 0, error: errorMessage(e) }));
      if (r.items && r.created) await supabase.from("contracts").update({ items: r.items }).eq("id", id);
      if (r.created) okNote = formData.get("stock_status") === "in_stock"
        ? `Dodano na stan ${r.created} szt. „nieprzypisane do Shopify” – przypiszesz je, gdy produkt będzie w Shopify.`
        : `${r.created} szt. „nieprzypisane do Shopify” w Przyjęcie dostawy → W drodze – przyjmiesz je, gdy dojdą.`;
      if (r.error) stockErr = `Umowa zapisana, ale ${r.created ? "nie wszystkie rzeczy" : "rzeczy nie"} trafiły do magazynu: ${r.error}`;
    }
    // Kilka jednakowych umów z tym samym plikiem (np. jedna faktura na kilka osobnych umów). Rzeczy, sprzedaż
    // i pozycje z katalogu trafiają tylko do pierwszej.
    const copies = Math.min(50, Math.max(1, Math.floor(Number(formData.get("copies") ?? 1)) || 1));
    if (copies > 1) {
      const { data: first } = await supabase.from("contracts").select("doc_number").eq("id", id).single();
      const { data: made, error: copyErr } = await supabase.from("contracts")
        .insert(Array.from({ length: copies - 1 }, () => ({ ...payload, doc_number: first?.doc_number ?? payload.doc_number }))).select("id");
      okNote = [copyErr
        ? `Utworzono 1 umowę – kopii nie udało się zapisać: ${copyErr.message}`
        : `Utworzono ${1 + (made?.length ?? 0)} jednakowych umów z tym samym plikiem. Rzeczy przypięte tylko do tej (pierwszej) – pozostałe są na liście niewykorzystanych.`, okNote].filter(Boolean).join(" ");
    }
    const saleId = String(formData.get("sale_id") ?? "");
    if (saleId) {
      // Kwota zakupu sztuki – z umowy, według tej samej reguły co przy przypinaniu (faktura: nie cała kwota).
      const { data: newUnit, error: attachErr } = await supabase.rpc("attach_sale_unit", { p_sale_id: saleId, p_contract_id: id, p_purchase_price: null, p_variant_id: String(formData.get("variant_id") ?? "") || null });
      if (attachErr) note = `?blad=${encodeURIComponent(`Umowa zapisana, ale nie przypięta do sprzedaży: ${attachErr.message}`)}`;
      else if (newUnit) {
        const pm = priceMessage(await inheritContractPrice(supabase, id, [newUnit as string]));
        const { data: nu } = await supabase.from("units").select("status").eq("id", newUnit as string).maybeSingle();
        const tr = nu?.status === "in_transit" ? "Rzecz jest w Przyjęcie dostawy → W drodze (pod zamówienie)." : "";
        okNote = [okNote, tr, pm].filter(Boolean).join(" ");
      }
    }
    // Umowa już zapisana – błąd przypinania (np. inna forma VAT) nie może jej cofnąć, tylko trafia do komunikatu.
    let attachError = "";
    const r = await attachByCodes(supabase, id, String(formData.get("units") ?? "")).catch((e: unknown) => {
      attachError = errorMessage(e);
      return { attached: 0, missing: [] as string[], price: { updated: [], problems: [], notes: [] } as PriceResult };
    });
    const pm = priceMessage(r.price);
    if (attachError) note = `?blad=${encodeURIComponent([okNote || "Umowa zapisana.", `Rzeczy NIE zostały przypięte: ${attachError}`].join(" "))}`;
    else if (r.missing.length || r.price.problems.length) note = `?blad=${encodeURIComponent([r.missing.length ? `Nie znaleziono sztuk: ${r.missing.join(", ")}.` : "Umowa zapisana i przypięta.", pm].filter(Boolean).join(" "))}`;
    else if (pm) okNote = [okNote, pm].filter(Boolean).join(" ");
    if (stockErr) note = `?blad=${encodeURIComponent([stockErr, note ? decodeURIComponent(note.slice(6)) : ""].filter(Boolean).join(" "))}`;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String((e as { message?: string }).message ?? e) };
  }
  revalidatePath("/umowy");
  revalidatePath("/magazyn");
  const returnTo = String(formData.get("returnTo") ?? "");
  if (returnTo.startsWith("/") && !returnTo.startsWith("//") && !note) {
    redirect(`${returnTo}${returnTo.includes("?") ? "&" : "?"}ok=${encodeURIComponent(["Umowa zapisana i przypięta.", okNote].filter(Boolean).join(" "))}`);
  }
  redirect(`/umowy/${id}${note || (okNote ? `?ok=${encodeURIComponent(okNote)}` : "")}`);
}

type ManualItem = { title: string; option: string; qty: number; price: number; manual: true };

/** Przedmioty faktury z formularza (JSON): nazwa, rozmiar, ilość, cena za sztukę. */
function parseManualItems(v: FormDataEntryValue | null): ManualItem[] {
  try {
    const raw = JSON.parse(String(v ?? "[]")) as { title?: unknown; option?: unknown; qty?: unknown; price?: unknown }[];
    return (Array.isArray(raw) ? raw : []).slice(0, 100).map((r) => ({
      title: String(r.title ?? "").trim().slice(0, 120),
      option: String(r.option ?? "").trim().slice(0, 40),
      qty: Math.min(9999, Math.max(1, Math.floor(Number(r.qty) || 1))),
      price: (() => { try { return parseAmount(String(r.price ?? "")) ?? 0; } catch { return 0; } })(),
      manual: true as const,
    })).filter((r) => r.title);
  } catch {
    return [];
  }
}

/** Dodanie przedmiotu faktury na stronie umowy (skan / faktura). */
export async function addContractItem(formData: FormData) {
  const { supabase, profile } = await requireSection("umowy", "dostawa");
  const id = String(formData.get("id") ?? "");
  const [item] = parseManualItems(JSON.stringify([{ title: formData.get("title"), option: formData.get("option"), qty: formData.get("qty"), price: profile.can_see_prices ? formData.get("price") : 0 }]));
  if (!item) redirect(`/umowy/${id}?blad=${encodeURIComponent("Wpisz nazwę przedmiotu.")}`);
  const { data: c } = await supabase.from("contracts").select("items, template").eq("id", id).maybeSingle();
  if (!c || c.template) redirect(`/umowy/${id}`);
  // „Dodaj do magazynu” → od razu sztuki na stanie, „nieprzypisane do Shopify”.
  const stockLoc = formData.get("to_stock") === "1" ? String(formData.get("stock_location_id") ?? "") : "";
  if (formData.get("to_stock") === "1" && !stockLoc) redirect(`/umowy/${id}?blad=${encodeURIComponent("Wybierz lokalizację, na którą trafi rzecz.")}`);
  let added: unknown[] = [item];
  let msg = "";
  if (stockLoc) {
    const { stockContractItems } = await import("@/lib/contracts/stock-items");
    const r = await stockContractItems(supabase, id, [item!], stockLoc, formData.get("stock_status") === "in_stock" ? "in_stock" : "in_transit").catch((e: unknown) => ({ items: [item!], created: 0, error: errorMessage(e) }));
    added = r.items;
    msg = r.error ? `blad=${encodeURIComponent(`Rzecz nie trafiła do magazynu: ${r.error}`)}` : `ok=${encodeURIComponent(formData.get("stock_status") === "in_stock" ? `Dodano na stan ${r.created} szt. „nieprzypisane do Shopify”.` : `${r.created} szt. „nieprzypisane do Shopify” w W drodze.`)}`;
  }
  const { error } = await supabase.from("contracts").update({ items: [...((c.items ?? []) as unknown[]), ...added] }).eq("id", id);
  if (error) redirect(`/umowy/${id}?blad=${encodeURIComponent(error.message)}`);
  revalidatePath(`/umowy/${id}`);
  revalidatePath("/magazyn");
  if (msg) redirect(`/umowy/${id}?${msg}`);
  redirect(`/umowy/${id}`);
}

/** Usunięcie pozycji z przedmiotów faktury (tylko wpisanych ręcznie albo z katalogu bez sztuki). */
export async function removeContractItem(formData: FormData) {
  const { supabase } = await requireSection("umowy", "dostawa");
  const id = String(formData.get("id") ?? "");
  const idx = Number(formData.get("idx"));
  const { data: c } = await supabase.from("contracts").select("items, template").eq("id", id).maybeSingle();
  const items = (c?.items ?? []) as { unit_id?: string }[];
  if (!c || c.template || !Number.isInteger(idx) || idx < 0 || idx >= items.length || items[idx].unit_id) redirect(`/umowy/${id}`);
  const { error } = await supabase.from("contracts").update({ items: items.filter((_, k) => k !== idx) }).eq("id", id);
  if (error) redirect(`/umowy/${id}?blad=${encodeURIComponent(error.message)}`);
  revalidatePath(`/umowy/${id}`);
  redirect(`/umowy/${id}`);
}

export async function attachUnits(formData: FormData) {
  const { supabase } = await requireSection("umowy", "dostawa");
  const id = String(formData.get("id"));
  let r: Awaited<ReturnType<typeof attachByCodes>>;
  try {
    r = await attachByCodes(supabase, id, String(formData.get("units") ?? ""));
  } catch (e) {
    redirect(`/umowy/${id}?blad=${encodeURIComponent(errorMessage(e))}`);
  }
  revalidatePath(`/umowy/${id}`);
  const pm = priceMessage(r.price);
  const text = [`Przypięto ${r.attached} szt.`, r.missing.length ? `Nie znaleziono: ${r.missing.join(", ")}.` : "", pm].filter(Boolean).join(" ");
  redirect(`/umowy/${id}?${r.missing.length || r.price.problems.length ? "blad" : "ok"}=${encodeURIComponent(text)}`);
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
  // Plik zostaje (na wszelki wypadek) – dostępny w Umowy → Historia przy usuniętej umowie.
  void c;
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
    .eq("id", id).eq("status", "signed").select("id, source, items, type");
  if (!accepted?.length) redirect(withMsg(target, "blad", "Zatwierdzić można tylko umowę podpisaną przez sprzedającego."));

  // Każda rzecz dostaje osobną umowę z własnym numerem (bez migracji 0040 – jedna umowa jak dotąd).
  // Faktura sprzedającego (wgrana zamiast podpisu) obejmuje wszystkie pozycje – bez dzielenia.
  const isInvoice = (accepted![0] as { type?: string }).type === "invoice";
  const split = isInvoice ? { data: [id], error: null } : await (await import("@/lib/supabase/admin")).createAdminClient().rpc("split_contract", { p_contract_id: id });
  const ids = (split.error ? [id] : (split.data as string[] | null) ?? [id]);
  // split_contract (SQL 40) nie zna późniejszych pól – nowe umowy dostają je z pierwotnej.
  if (ids.length > 1) {
    const { data: orig } = await supabase.from("contracts").select("doc_number, vat_form, amount_per_item").eq("id", id).maybeSingle();
    if (orig) await supabase.from("contracts").update(orig).in("id", ids.filter((x) => x !== id));
  }
  const msgs: string[] = [ids.length > 1 ? `Umowa zatwierdzona i podzielona na ${ids.length} umowy – osobna dla każdej rzeczy.` : "Umowa zatwierdzona."];

  // Umowa z ogólnego linku czeka jeszcze na przypisanie pozycji do katalogu; pozostałe od razu tworzą sztuki.
  const { data: group } = await supabase.from("contracts").select("id, number, items").in("id", ids);
  let created = 0;
  let unlinked = false;
  const errors: string[] = [];
  for (const g of group ?? []) {
    let items = (g.items ?? []) as { unit_id?: string; variant_id?: string; title?: string; option?: string; unassigned?: boolean }[];
    // Pozycje spoza katalogu (np. z ogólnego linku) → produkt „nieprzypisany do Shopify”; przypiszesz go na karcie sztuki.
    if (items.some((i) => !i.unit_id && !i.variant_id)) {
      const admin = (await import("@/lib/supabase/admin")).createAdminClient();
      const next = [];
      for (const it of items) {
        if (it.unit_id || it.variant_id) { next.push(it); continue; }
        const { data: nv, error: ne } = await admin.rpc("create_unassigned_variant", { p_title: it.title ?? "", p_option: it.option ?? "" });
        next.push(ne || !nv ? it : { ...it, variant_id: nv as string, unassigned: true });
      }
      if (next.every((i) => i.unit_id || i.variant_id)) {
        await supabase.from("contracts").update({ items: next }).eq("id", g.id);
        items = next;
        msgs.push("Rzeczy spoza katalogu mają status „nieprzypisany do Shopify” – przypisz je na karcie sztuki.");
      }
    }
    if (items.every((i) => i.unit_id || i.variant_id)) {
      const fin = await supabase.rpc("finalize_contract", { p_contract_id: g.id });
      if (fin.error) errors.push(`Sztuki (NR${g.number}): ${fin.error.message}`);
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
  else if (isInvoice) msgs[0] = "Faktura sprzedającego zatwierdzona.";
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
  const patch: Record<string, unknown> = {
    doc_number: String(formData.get("doc_number") ?? "").trim().slice(0, 60) || null,
    ...(currency ? { currency: ["PLN", "EUR"].includes(currency) ? currency : null } : {}),
    ...(formData.has("vat_form") ? { vat_form: ["vat_margin", "vat_23"].includes(String(formData.get("vat_form"))) ? String(formData.get("vat_form")) : null } : {}),
  };
  // Kwota i „za każdą rzecz” – tylko gdy pola są w formularzu (osoba widzi ceny).
  if (formData.has("amount")) {
    try {
      patch.amount = parseAmount(formData.get("amount"));
    } catch (e) {
      redirect(`/umowy/${id}?blad=${encodeURIComponent(errorMessage(e))}`);
    }
    patch.amount_per_item = formData.get("amount_per_item") === "1";
  }
  let error: { message: string } | null = (await supabase.from("contracts").update(patch).eq("id", id)).error;
  if (error && /amount_per_item/.test(error.message)) {
    delete patch.amount_per_item;
    error = (await supabase.from("contracts").update(patch).eq("id", id)).error;
    if (!error) error = { message: "Zapisano bez „kwota za każdą rzecz” – uruchom w Supabase SQL 0055_contract_amount_per_item.sql." };
  }
  // Kwoty sztuk na umowie według nowej kwoty (puste uzupełnione, różnice opisane).
  const price = !error && formData.has("amount") ? await inheritContractPrice(supabase, id) : null;
  revalidatePath(`/umowy/${id}`);
  revalidatePath("/magazyn");
  const text = error ? error.message : ["Zapisano.", price ? priceMessage(price) : ""].filter(Boolean).join(" ");
  redirect(`/umowy/${id}?${error || price?.problems.length ? "blad" : "ok"}=${encodeURIComponent(text)}`);
}

/** Umowa bez rzeczy → sztuka z magazynu (albo sprzedana sztuka) bez umowy. */
export async function assignContractToUnit(formData: FormData) {
  const { supabase } = await requireSection("umowy", "dostawa");
  const contractId = String(formData.get("contract_id") ?? "");
  const unitId = String(formData.get("unit_id") ?? "");
  const back = `/umowy/${contractId}/przypisz`;
  const { data: c } = await supabase.from("contracts").select("id, amount, status").eq("id", contractId).maybeSingle();
  if (!c || ["cancelled", "rejected", "sent"].includes(c.status as string)) redirect(`${back}?blad=${encodeURIComponent("Ta umowa jest anulowana, czeka na podpis albo nie istnieje.")}`);
  // Umowa zajęta przez inną rzecz – nie przypinamy drugiej.
  const taken = await contractTakenError(supabase, contractId, 1, [unitId]);
  if (taken) redirect(`${back}?blad=${encodeURIComponent(taken)}`);
  const { data: u } = await supabase.from("units").select("id, code, purchase_price, owner_type, status").eq("id", unitId).maybeSingle();
  if (!u || u.owner_type !== "own" || !["in_stock", "reserved", "in_transit", "sold", "shipped"].includes(u.status as string)) redirect(`${back}?blad=${encodeURIComponent("Tej sztuki nie można powiązać z umową (komis, wycofana albo oddana).")}`);
  const { data: updated, error } = await supabase.from("units").update({ contract_id: contractId }).eq("id", unitId).is("contract_id", null).select("id");
  if (error || !updated?.length) redirect(`${back}?blad=${encodeURIComponent(error?.message ?? "Ta sztuka ma już umowę (1 umowa na przedmiot).")}`);
  await supabase.from("unit_events").insert({ unit_id: unitId, type: "contract", data: { contract_id: contractId, note: "umowa przypisana z listy umów bez rzeczy" } });
  // Kwota zakupu z umowy (albo opis, dlaczego się różni).
  const price = await inheritContractPrice(supabase, contractId, [unitId]);
  revalidatePath("/umowy");
  revalidatePath("/magazyn");
  const text = [`Umowa przypisana do sztuki ${u!.code}.`, priceMessage(price)].filter(Boolean).join(" ");
  redirect(`/umowy/${contractId}?${price.problems.length ? "blad" : "ok"}=${encodeURIComponent(text)}`);
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
    const price = await inheritContractPrice(supabase, contractId, [unit.id]);
    if (price.problems.length || price.updated.length || price.notes.length) {
      revalidatePath("/umowy");
      revalidatePath("/sprzedaz");
      redirect(`/umowy/${contractId}?${price.problems.length ? "blad" : "ok"}=${encodeURIComponent(["Umowa przypisana do sprzedanego przedmiotu.", priceMessage(price)].join(" "))}`);
    }
  } else {
    const { data: newUnit, error: e } = await supabase.rpc("attach_sale_unit", { p_sale_id: saleId, p_contract_id: contractId, p_purchase_price: null, p_variant_id: null });
    if (e) return fail(e.message);
    const price = newUnit ? await inheritContractPrice(supabase, contractId, [newUnit as string]) : null;
    if (price && (price.problems.length || price.updated.length || price.notes.length)) {
      revalidatePath("/umowy");
      revalidatePath("/sprzedaz");
      redirect(`/umowy/${contractId}?${price.problems.length ? "blad" : "ok"}=${encodeURIComponent(["Umowa przypisana do sprzedanego przedmiotu.", priceMessage(price)].join(" "))}`);
    }
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

export type NoContractUnit = { id: string; code: string; identifier: string | null; title: string; option: string; status: string; store: string | null; image: string | null; used: boolean };

/** Rzeczy w sklepie bez umowy (na stanie, zarezerwowane, w drodze) – do wyboru przy nowej umowie. */
export async function searchUnitsWithoutContract(q: string): Promise<NoContractUnit[]> {
  const { supabase } = await requireSection("umowy", "dostawa");
  const text = q.trim().replace(/[,()*%\\]/g, " ").trim();
  let query = supabase.from("units_list").select("id, code, identifier, title, option, status, store_name, image_url, product_id, store_id")
    .is("contract_id", null).in("status", ["in_stock", "reserved", "in_transit"]).order("received_at", { ascending: false }).limit(30);
  const ex = text.length >= 2 ? wordsOr(["title", "code", "identifier", "style_sku", "option"], searchWords(text)) : null;
  if (ex) query = query.or(ex);
  const { data } = await query;
  const used = await reusedProducts(supabase, (data ?? []).map((u) => u.product_id as string));
  return (data ?? []).map((u) => ({
    id: u.id as string, code: u.code as string, identifier: (u.identifier as string | null) ?? null, title: u.title as string, option: u.option as string,
    status: u.status as string, store: (u.store_name as string | null) ?? null, image: (u.image_url as string | null) ?? null,
    used: used(u.product_id as string, u.store_id as string | null),
  }));
}

/** Umowa z szablonu przed podpisem: waluta ustalona przez nas (sprzedający jej nie zmieni) albo do wyboru przy podpisie. */
export async function setTemplateCurrency(formData: FormData) {
  const { supabase } = await requireSection("umowy", "dostawa");
  const id = String(formData.get("id") ?? "");
  const cur = String(formData.get("currency") ?? "");
  const currency = cur === "PLN" || cur === "EUR" ? cur : null;
  const { data, error } = await supabase.from("contracts").update({ currency }).eq("id", id).eq("status", "sent").not("template", "is", null).select("id");
  const msg = error ? `blad=${encodeURIComponent(error.message)}` : !data?.length ? `blad=${encodeURIComponent("Walutę można zmienić tylko przed podpisem.")}` : `ok=${encodeURIComponent(currency ? `Waluta umowy: ${currency}.` : "Walutę wybierze sprzedający przy podpisie.")}`;
  revalidatePath(`/umowy/${id}`);
  redirect(`/umowy/${id}?${msg}`);
}

/** Forma zapłaty umowy z szablonu przed opłaceniem (np. faktura wgrana bez numeru konta). */
export async function setContractPayment(formData: FormData) {
  const { supabase } = await requireSection("umowy", "dostawa");
  const id = String(formData.get("id") ?? "");
  const method = formData.get("payment_method") === "cash" ? "cash" : "transfer";
  const account = method === "transfer" ? String(formData.get("bank") ?? "").trim().slice(0, 80) || null : null;
  const { data, error } = await supabase.from("contracts").update({ payment_method: method, seller_bank_account: account })
    .eq("id", id).is("paid_at", null).select("id");
  const msg = error ? `blad=${encodeURIComponent(error.message)}`
    : !data?.length ? `blad=${encodeURIComponent("Opłaconej umowy nie można już zmienić.")}`
    : `ok=${encodeURIComponent(method === "cash" ? "Zapłata: gotówka." : account ? "Zapłata: przelew – konto zapisane." : "Zapłata: przelew – wpisz jeszcze numer konta.")}`;
  revalidatePath(`/umowy/${id}`);
  revalidatePath("/umowy");
  redirect(`/umowy/${id}?${msg}`);
}
