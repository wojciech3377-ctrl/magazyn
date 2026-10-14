"use server";

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
    supabase.from("contracts").select("id, amount, status, sale_id, number, counterparty").eq("id", contractId).maybeSingle(),
    supabase.from("contracts_unused").select("id").eq("id", contractId).maybeSingle(),
  ]);
  if (!c || ["cancelled", "rejected", "sent"].includes(c.status as string)) return fail("Ta umowa jest anulowana, czeka na podpis albo nie istnieje.");
  if (!unused) return fail("Ta umowa jest już przypisana do innej rzeczy.");
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
      const text = [`Umowa ${c.number ? `nr ${c.number} ` : ""}przypisana do sprzedaży.`, price ? priceMessage(price) : ""].filter(Boolean).join(" ");
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
  const text = [`Umowa ${c.number ? `nr ${c.number} ` : ""}przypisana.`, priceMessage(price)].filter(Boolean).join(" ");
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
  const { data: o } = await db.from("pos_orders").select("id, code").eq("id", id).maybeSingle();
  if (!o) return go("blad", "Nie ma takiej sprzedaży.");
  const { data: inv } = await db.from("invoices").select("number").eq("pos_order_id", id).not("status", "in", "(rejected,cancelled)").limit(1).maybeSingle();
  if (inv) return go("blad", `Do tej sprzedaży jest faktura ${inv.number} – najpierw ją usuń albo skoryguj.`);
  const { data: items } = await db.from("pos_order_items").select("unit_id, status").eq("order_id", id);
  const unitIds = (items ?? []).filter((i) => i.status === "sold" && i.unit_id).map((i) => i.unit_id as string);
  let back1: { id: string; variant_id: string; location_id: string }[] = [];
  if (unitIds.length) {
    const { data } = await db.from("units").update({ status: "in_stock", sold_at: null }).in("id", unitIds).in("status", ["sold", "shipped"]).select("id, variant_id, location_id");
    back1 = (data ?? []) as typeof back1;
    if (back1.length) await db.from("unit_events").insert(back1.map((u) => ({ unit_id: u.id, type: "status", data: { to: "in_stock", note: `sprzedaż ${o.code} usunięta` } })));
  }
  const { error } = await db.from("pos_orders").delete().eq("id", id);
  if (error) return go("blad", errorMessage(error));
  const { adjustStock } = await import("@/lib/stock");
  if (back1.length) await adjustStock(supabase, back1.map((u) => ({ variantId: u.variant_id, locationId: u.location_id, delta: 1 })));
  revalidatePath("/sprzedaz");
  return go("ok", `Sprzedaż ${o.code} usunięta${back1.length ? `, ${back1.length} szt. wróciło na stan` : ""}.`);
}
