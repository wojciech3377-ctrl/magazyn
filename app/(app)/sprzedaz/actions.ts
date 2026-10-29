"use server";

import { PAR_PREFIX } from "@/lib/orders/par-order";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin, requireSection } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncFurgonetkaShipments, syncShopifyOrders } from "@/lib/sync/shop-orders";
import { furgonetkaConfigured, furgonetkaConnection } from "@/lib/integrations/furgonetka";
import { errorMessage } from "@/lib/errors";
import { parsePieceRef } from "@/lib/orders/pieces";
import { inheritContractPrice, priceMessage } from "@/lib/contracts/inherit-price";

/** Zamiana sztuki przy pakowaniu: skan kodu sztuki, IMEI albo numeru seryjnego. */
export async function swapUnit(_: unknown, formData: FormData): Promise<{ ok?: string; error?: string }> {
  const { supabase } = await requireSection("sprzedaz");
  const saleId = String(formData.get("sale_id"));
  const code = String(formData.get("code") ?? "").trim();
  if (!code) return { error: "Zeskanuj albo wpisz kod sztuki." };
  const { error } = await supabase.rpc("swap_sale_unit", { p_sale_id: saleId, p_code: code });
  if (error) return { error: error.message };
  revalidatePath("/sprzedaz");
  return { ok: "Sztuka zmieniona." };
}

/** Ręczne pobranie: zamówienia ze Shopify i przesyłki z Furgonetki (to samo robi zadanie cykliczne). */
export async function pullOrdersNow() {
  await requireAdmin();
  const db = createAdminClient();
  const jobs: [string, () => Promise<unknown>][] = [
    ["shopify-orders", () => syncShopifyOrders(db, 10, 7)],
  ];
  if (furgonetkaConfigured() && (await furgonetkaConnection(db))) jobs.push(["furgonetka", () => syncFurgonetkaShipments(db)]);
  for (const [job, fn] of jobs) {
    try {
      const result = await fn();
      await db.from("sync_log").insert({ job, ok: true, message: JSON.stringify(result) });
    } catch (e) {
      await db.from("sync_log").insert({ job, ok: false, message: errorMessage(e) });
    }
  }
  revalidatePath("/sprzedaz");
}

/**
 * „Dołącz umowę” do jednej sztuki pozycji zamówienia: linia sprzedaży powstaje w razie potrzeby, a potem
 * wybór – gotowa umowa, umowa do podpisu (link) albo skan. Gdy umowa już jest albo jest w toku – otwiera ją.
 * Przycisk podaje „<zamówienie>|<pozycja>|<sztuka>” w polu umowa_dla.
 */
export async function attachContractForPiece(formData: FormData) {
  const { supabase } = await requireSection("sprzedaz");
  const ref = parsePieceRef(String(formData.get("umowa_dla") ?? ""));
  const back = safeBack(String(formData.get("back") ?? ""));
  const fail = (msg: string) => redirect(`${back}${back.includes("?") ? "&" : "?"}blad=${encodeURIComponent(msg)}`);
  if (!ref) return fail("Nie rozpoznałem pozycji zamówienia.");
  const { data: saleId, error } = await supabase.rpc("ensure_order_line_sale", { p_order_id: ref.orderId, p_line_id: ref.lineId, p_index: ref.n });
  if (error || !saleId) return fail(error?.message ?? "Nie udało się przygotować sprzedaży.");
  const { data: sale } = await supabase.from("sales").select("id, unit:units(id, contract_id)").eq("id", saleId as string).single();
  const unit = sale?.unit as unknown as { id: string; contract_id: string | null } | null;
  if (unit?.contract_id) redirect(`/umowy/${unit.contract_id}`);
  const { data: pending } = await supabase.from("contracts").select("id").eq("sale_id", saleId as string).not("status", "in", "(cancelled,rejected)").limit(1).maybeSingle();
  if (pending) redirect(`/umowy/${pending.id}`);
  redirect(`/sprzedaz/umowa?sprzedaz=${saleId}&back=${encodeURIComponent(back)}`);
}

/** Powrót tylko na strony sprzedaży (bez przekierowań na zewnątrz). */
function safeBack(v: string) {
  return (v.startsWith("/sprzedaz") || v.startsWith("/magazyn")) && !v.startsWith("//") ? v : "/sprzedaz";
}

/**
 * Gotowa umowa (niewykorzystana) → sprzedana rzecz: do sztuki z magazynu albo – gdy sprzedaż nie ma sztuki –
 * umowa tworzy sprzedaną sztukę. 1 umowa na przedmiot.
 */
export async function attachExistingContract(formData: FormData) {
  const { supabase } = await requireSection("sprzedaz");
  const contractId = String(formData.get("contract_id") ?? "");
  const saleId = String(formData.get("sale_id") ?? "");
  const unitParam = String(formData.get("unit_id") ?? "");
  const back = safeBack(String(formData.get("back") ?? ""));
  const self = `/sprzedaz/umowa?${saleId ? `sprzedaz=${saleId}` : `sztuka=${unitParam}`}&back=${encodeURIComponent(back)}`;
  const fail = (m: string) => redirect(`${self}&blad=${encodeURIComponent(m)}`);

  const [{ data: c }, { data: unused }] = await Promise.all([
    supabase.from("contracts").select("id, amount, status, sale_id, number, doc_number, counterparty").eq("id", contractId).maybeSingle(),
    supabase.from("contracts_unused").select("id").eq("id", contractId).maybeSingle(),
  ]);
  if (!c || ["cancelled", "rejected", "sent"].includes(c.status as string)) return fail("Ta umowa jest anulowana, czeka na podpis albo nie istnieje.");
  // Umowa „kwota za każdą rzecz” (bez pozycji) obejmuje kilka rzeczy – można ją dołączać do kolejnych sprzedaży.
  if (!unused) {
    const { contractTakenError } = await import("@/lib/contracts/free");
    const { data: full } = await supabase.from("contracts").select("*").eq("id", contractId).maybeSingle();
    const perItem = !!(full as { amount_per_item?: boolean } | null)?.amount_per_item && !((full as { items?: unknown[] } | null)?.items ?? []).length;
    if (!perItem) return fail("Ta umowa jest już przypisana do innej rzeczy.");
    const taken = await contractTakenError(supabase, contractId, 1);
    if (taken) return fail(taken);
  }
  if (c.sale_id && c.sale_id !== saleId) return fail("Ta umowa jest przygotowana do innej sprzedaży.");

  type U = { id: string; contract_id: string | null; owner_type: string; purchase_price: number | null; status: string };
  let unit: U | null = null;
  if (saleId) {
    const { data: sale } = await supabase.from("sales").select("id, status, variant_id, unit:units(id, contract_id, owner_type, purchase_price, status)").eq("id", saleId).maybeSingle();
    if (!sale || sale.status === "cancelled") return fail("Ta sprzedaż jest anulowana albo nie istnieje.");
    unit = sale.unit as unknown as U | null;
    if (!unit) {
      const variant = String(formData.get("variant_id") ?? "") || null;
      if (!sale.variant_id && !variant) return fail("Wybierz produkt i rozmiar z katalogu – sprzedaż nie jest z nim powiązana.");
      const { data: newUnit, error } = await supabase.rpc("attach_sale_unit", { p_sale_id: saleId, p_contract_id: contractId, p_purchase_price: null, p_variant_id: variant });
      if (error) return fail(error.message);
      // Kwota zakupu z umowy według wspólnej reguły (faktura na kilka rzeczy – nie cała kwota każdej).
      const price = newUnit ? await inheritContractPrice(supabase, contractId, [newUnit as string]) : null;
      revalidatePath("/sprzedaz");
      revalidatePath("/umowy");
      const { data: nu } = newUnit ? await supabase.from("units").select("status").eq("id", newUnit as string).maybeSingle() : { data: null };
      const text = [`Umowa ${c.doc_number ? `${c.doc_number} ` : c.number ? `NR${c.number} ` : ""}przypisana do sprzedaży.`, nu?.status === "in_transit" ? "Rzecz jest w Przyjęcie dostawy → W drodze (pod zamówienie) – po przyjściu trafi do zamówienia." : "", price ? priceMessage(price) : ""].filter(Boolean).join(" ");
      redirect(`${back}${back.includes("?") ? "&" : "?"}${price?.problems.length ? "blad" : "ok"}=${encodeURIComponent(text)}`);
    }
  } else {
    const { data: u } = await supabase.from("units").select("id, contract_id, owner_type, purchase_price, status").eq("id", unitParam).maybeSingle();
    unit = u as U | null;
  }
  if (!unit || ["removed", "consignor_returned"].includes(unit.status)) return fail("Nie ma takiej sztuki.");
  if (unit.contract_id) return fail("Ta rzecz ma już umowę (1 umowa na przedmiot).");
  const { data: upd, error } = await supabase.from("units").update({ contract_id: contractId }).eq("id", unit.id).is("contract_id", null).select("id");
  if (error) return fail(error.message);
  if (!upd?.length) return fail("Ta rzecz ma już umowę (1 umowa na przedmiot).");
  await supabase.from("unit_events").insert({ unit_id: unit.id, type: "contract", data: { contract_id: contractId, sale_id: saleId || null, note: "gotowa umowa dołączona do sprzedaży" } });
  const price = await inheritContractPrice(supabase, contractId, [unit.id]);
  revalidatePath("/sprzedaz");
  revalidatePath("/umowy");
  const text = [`Umowa ${c.doc_number ? `${c.doc_number} ` : c.number ? `NR${c.number} ` : ""}przypisana.`, priceMessage(price)].filter(Boolean).join(" ");
  redirect(`${back}${back.includes("?") ? "&" : "?"}${price.problems.length ? "blad" : "ok"}=${encodeURIComponent(text)}`);
}

/**
 * Usunięcie sprzedaży stacjonarnej (administrator): sprzedane sztuki wracają na stan (+1 w Shopify),
 * wydrukowany paragon fiskalny zostaje w JPK (migracja 0046). Sprzedaży z fakturą nie usuwa się – najpierw faktura.
 */
export async function deletePosOrder(formData: FormData) {
  const { supabase } = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const back = safeBack(String(formData.get("back") ?? "/sprzedaz?widok=stacjonarna"));
  const go = (key: "ok" | "blad", m: string) => redirect(`${back}${back.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(m)}`);
  const db = createAdminClient();
  const { data: o } = await db.from("pos_orders").select("id, code, base_pending").eq("id", id).maybeSingle();
  if (!o) return go("blad", "Nie ma takiej sprzedaży.");
  // Paragon w drukarce (w kolejce / drukuje się) – usunięcie skasowałoby zadanie, a paragon i tak by wyszedł.
  const { count: printing } = await db.from("receipt_jobs").select("id", { count: "exact", head: true }).eq("pos_order_id", id).in("status", ["queued", "printing"]);
  if (printing) return go("blad", "Paragon tej sprzedaży czeka w drukarce albo właśnie się drukuje – poczekaj na wydruk (albo anuluj zadanie w Ustawieniach → Drukarka) i spróbuj ponownie.");
  const { data: docs } = await db.from("invoices").select("id, number, kind, order_id").eq("pos_order_id", id).not("status", "in", "(rejected,cancelled)");
  const inv = (docs ?? []).find((d) => d.kind !== "receipt");
  if (inv) return go("blad", `Do tej sprzedaży jest faktura ${inv.number} – najpierw ją usuń albo skoryguj.`);
  // Paragon PDF (PAR, bez paragonu fiskalnego, poza JPK) nie blokuje – jest anulowany razem ze sprzedażą.
  // Wysyłka z paragonu: zamówienie znika razem z nim, chyba że ma już etykietę.
  const pars = (docs ?? []).filter((d) => d.kind === "receipt");
  const { data: parOrders } = pars.length
    ? await db.from("orders").select("id").or([`shopify_order_id.in.(${pars.map((p) => `"${PAR_PREFIX}${p.id}"`).join(",")})`, ...pars.filter((p) => p.order_id).map((p) => `id.eq.${p.order_id}`)].join(","))
    : { data: [] };
  const parOrderIds = (parOrders ?? []).map((o) => o.id as string);
  if (parOrderIds.length) {
    const { data: ships } = await db.from("shipments").select("state").in("order_id", parOrderIds);
    if ((ships ?? []).some((sh) => !/cancel/i.test(String(sh.state ?? "")))) return go("blad", "Ta sprzedaż ma wysyłkę z etykietą – najpierw anuluj przesyłkę w zamówieniu (Sprzedaż → Zamówienia), potem usuń sprzedaż.");
  }
  const { data: items } = await db.from("pos_order_items").select("unit_id, status").eq("order_id", id);
  let unitIds = (items ?? []).filter((i) => i.status === "sold" && i.unit_id).map((i) => i.unit_id as string);
  // Sztuki utworzone tylko do „Dołącz umowę” przy pozycji wpisanej ręcznie – nigdy nie były na stanie:
  // nie wracają na stan (to byłby towar z niczego), tylko znikają z magazynu.
  if (unitIds.length) {
    const { data: made } = await db.from("unit_events").select("unit_id").in("unit_id", unitIds).eq("type", "status").like("data->>note", "sztuka utworzona do sprzedanej pozycji%");
    const phantom = [...new Set((made ?? []).map((e) => e.unit_id as string))];
    if (phantom.length) {
      await db.from("units").update({ status: "removed", contract_id: null }).in("id", phantom);
      await db.from("unit_events").insert(phantom.map((u) => ({ unit_id: u, type: "status", data: { to: "removed", note: `sprzedaż ${o.code} usunięta (sztuka tylko do umowy)` } })));
      unitIds = unitIds.filter((u) => !phantom.includes(u));
    }
  }
  let back1: { id: string; variant_id: string; location_id: string }[] = [];
  if (unitIds.length) {
    const { data } = await db.from("units").update({ status: "in_stock", sold_at: null }).in("id", unitIds).in("status", ["sold", "shipped"]).select("id, variant_id, location_id");
    back1 = (data ?? []) as typeof back1;
    if (back1.length) await db.from("unit_events").insert(back1.map((u) => ({ unit_id: u.id, type: "status", data: { to: "in_stock", note: `sprzedaż ${o.code} usunięta` } })));
  }
  if (pars.length) {
    await db.from("invoices").update({ status: "cancelled", notes: `Anulowany – sprzedaż ${o.code} usunięta.` }).in("id", pars.map((p) => p.id));
  }
  if (parOrderIds.length) {
    await db.from("sales").delete().in("order_id", parOrderIds);
    await db.from("orders").delete().in("id", parOrderIds);
  }
  const { error } = await db.from("pos_orders").delete().eq("id", id);
  if (error) return go("blad", errorMessage(error));
  const { adjustStock } = await import("@/lib/stock");
  // −1 z tej sprzedaży, które nie doszło do Shopify (base_pending), znosi się z +1 – inaczej stan wzrósłby ponad prawdę.
  const notSent = new Map<string, number>();
  for (const p of (o.base_pending ?? []) as { variantId: string; locationId: string; delta: number }[]) {
    if (p.delta < 0) notSent.set(`${p.variantId}|${p.locationId}`, (notSent.get(`${p.variantId}|${p.locationId}`) ?? 0) - p.delta);
  }
  const plus = back1.filter((u) => {
    const k = `${u.variant_id}|${u.location_id}`;
    const n = notSent.get(k) ?? 0;
    if (n <= 0) return true;
    notSent.set(k, n - 1);
    return false;
  });
  if (plus.length) await adjustStock(supabase, plus.map((u) => ({ variantId: u.variant_id, locationId: u.location_id, delta: 1 })));
  revalidatePath("/sprzedaz");
  return go("ok", `Sprzedaż ${o.code} usunięta${back1.length ? `, ${back1.length} szt. wróciło na stan` : ""}${pars.length ? `, paragon PDF ${pars.map((p) => p.number).join(", ")} anulowany` : ""}${parOrderIds.length ? ", zamówienie do wysyłki usunięte" : ""}.`);
}

const JPK_KEY = /^(o:[0-9a-f-]{36}:\d{1,3}:\d{1,3}|[pik]:[0-9a-f-]{36}|r:[0-9a-f-]{36}:\d{1,4})$/i;

/** Notatka do linii JPK (zapis po wyjściu z pola; pusta – usuwa). Trafia też do pliku Excel (kolumna „Uwagi”). */
export async function saveJpkNote(key: string, note: string): Promise<{ ok?: true; error?: string }> {
  const { supabase } = await requireSection("sprzedaz", "faktury");
  if (!JPK_KEY.test(key)) return { error: "Nieznana linia." };
  const text = note.replace(/\s+/g, " ").trim().slice(0, 500);
  const { error } = text
    ? await supabase.from("jpk_notes").upsert({ line_key: key, note: text, updated_at: new Date().toISOString() })
    : await supabase.from("jpk_notes").delete().eq("line_key", key);
  if (error) return { error: /jpk_notes|schema cache/i.test(error.message) ? "Notatki wymagają SQL 59 w Supabase." : error.message };
  return { ok: true };
}

/** JPK: „nie dotyczy” przy pozycji bez umowy (włącz / cofnij). Pozycja dalej jest w JPK i w Excelu. */
export async function setJpkNa(key: string, on: boolean): Promise<{ ok?: true; error?: string }> {
  const { supabase } = await requireSection("sprzedaz", "faktury");
  if (!JPK_KEY.test(key)) return { error: "Nieznana linia." };
  const { error } = on
    ? await supabase.from("jpk_na").upsert({ line_key: key })
    : await supabase.from("jpk_na").delete().eq("line_key", key);
  if (error) return { error: /jpk_na|schema cache/i.test(error.message) ? "„Nie dotyczy” wymaga SQL 85 w Supabase." : error.message };
  revalidatePath("/sprzedaz");
  return { ok: true };
}

/**
 * „Dołącz umowę” do pozycji bez sztuki z magazynu (kasa: pozycja wpisana z nazwy / produkt własny; faktura ręczna):
 * wybrany produkt i rozmiar z katalogu → sprzedana sztuka → zwykłe dołączanie umowy do sztuki.
 */
export async function createUnitForLine(formData: FormData) {
  const { supabase } = await requireSection("sprzedaz", "faktury");
  const ref = String(formData.get("ref") ?? "");
  const variant = String(formData.get("variant_id") ?? "");
  const back = safeBack(String(formData.get("back") ?? ""));
  const m = /^(pos|fv):([0-9a-f-]{36})$/.exec(ref);
  const self = `/sprzedaz/umowa/pozycja?ref=${encodeURIComponent(ref)}&back=${encodeURIComponent(back)}`;
  if (!m) redirect(back);
  let variantId = variant;
  if (formData.get("offcatalog")) {
    // Rzecz spoza katalogu (np. skarpety wpisane w Kasie z nazwy): produkt „nieprzypisany” z nazwą pozycji.
    const { data: line } = m[1] === "pos"
      ? await supabase.from("pos_order_items").select("name").eq("id", m[2]).maybeSingle()
      : await supabase.from("invoice_items").select("name").eq("id", m[2]).maybeSingle();
    if (!line) redirect(back);
    const { data: vid, error: verr } = await supabase.rpc("create_unassigned_variant", { p_title: String(line.name ?? "pozycja"), p_option: "jeden rozmiar" });
    if (verr || !vid) redirect(`${self}&blad=${encodeURIComponent(verr && /create_unassigned_variant|schema cache/i.test(verr.message) ? "Ta funkcja wymaga SQL 63 w Supabase." : verr?.message ?? "Nie udało się utworzyć sztuki.")}`);
    variantId = vid as string;
  } else if (!/^[0-9a-f-]{36}$/.test(variant)) {
    redirect(`${self}&blad=${encodeURIComponent("Wybierz produkt i rozmiar z listy podpowiedzi – albo kliknij „Bez katalogu – dalej”.")}`);
  }
  const { data: unitId, error } = await supabase.rpc("create_line_unit", { p_kind: m[1] === "pos" ? "pos" : "invoice", p_item: m[2], p_variant: variantId });
  if (error || !unitId) {
    const msg = error && /create_line_unit|schema cache/i.test(error.message) ? "Ta funkcja wymaga SQL 59 w Supabase." : error?.message ?? "Nie udało się utworzyć sztuki.";
    redirect(`${self}&blad=${encodeURIComponent(msg)}`);
  }
  revalidatePath("/sprzedaz");
  redirect(`/sprzedaz/umowa?sztuka=${unitId}&back=${encodeURIComponent(back)}`);
}
