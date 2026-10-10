"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin, requireProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncBaseOrders } from "@/lib/sync/orders";
import { syncFurgonetkaShipments, syncShopifyOrders } from "@/lib/sync/shop-orders";
import { fetchReceiptsForOrders, syncBaseReceipts } from "@/lib/sync/receipts";
import { furgonetkaConfigured, furgonetkaConnection } from "@/lib/integrations/furgonetka";
import { errorMessage } from "@/lib/errors";
import { parsePieceRef } from "@/lib/orders/pieces";

/** Zamiana sztuki przy pakowaniu: skan kodu sztuki, IMEI albo numeru seryjnego. */
export async function swapUnit(_: unknown, formData: FormData): Promise<{ ok?: string; error?: string }> {
  const { supabase } = await requireProfile();
  const saleId = String(formData.get("sale_id"));
  const code = String(formData.get("code") ?? "").trim();
  if (!code) return { error: "Zeskanuj albo wpisz kod sztuki." };
  const { error } = await supabase.rpc("swap_sale_unit", { p_sale_id: saleId, p_code: code });
  if (error) return { error: error.message };
  revalidatePath("/sprzedaz");
  return { ok: "Sztuka zmieniona." };
}

/** Ręczne pobranie: linie z Base, zamówienia ze Shopify i przesyłki z Furgonetki (to samo robi zadanie co 5 minut). */
export async function pullOrdersNow() {
  await requireAdmin();
  const db = createAdminClient();
  const jobs: [string, () => Promise<unknown>][] = [
    ["base-orders", () => syncBaseOrders(db)],
    ["shopify-orders", () => syncShopifyOrders(db)],
    ["base-receipts", () => syncBaseReceipts(db)],
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
  const { supabase } = await requireProfile();
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
  return v.startsWith("/sprzedaz") && !v.startsWith("//") ? v : "/sprzedaz";
}

/**
 * Gotowa umowa (niewykorzystana) → sprzedana rzecz: do sztuki z magazynu albo – gdy sprzedaż nie ma sztuki –
 * umowa tworzy sprzedaną sztukę. 1 umowa na przedmiot.
 */
export async function attachExistingContract(formData: FormData) {
  const { supabase } = await requireProfile();
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
      const { error } = await supabase.rpc("attach_sale_unit", { p_sale_id: saleId, p_contract_id: contractId, p_purchase_price: c.amount ?? null, p_variant_id: variant });
      if (error) return fail(error.message);
      revalidatePath("/sprzedaz");
      revalidatePath("/umowy");
      redirect(`${back}${back.includes("?") ? "&" : "?"}ok=${encodeURIComponent(`Umowa ${c.number ? `nr ${c.number} ` : ""}przypisana do sprzedaży.`)}`);
    }
  } else {
    const { data: u } = await supabase.from("units").select("id, contract_id, owner_type, purchase_price, status").eq("id", unitParam).maybeSingle();
    unit = u as U | null;
  }
  if (!unit || ["removed", "consignor_returned"].includes(unit.status)) return fail("Nie ma takiej sztuki.");
  if (unit.contract_id) return fail("Ta rzecz ma już umowę (1 umowa na przedmiot).");
  const patch: Record<string, unknown> = { contract_id: contractId };
  if (unit.owner_type === "own" && unit.purchase_price === null && c.amount !== null) patch.purchase_price = c.amount;
  const { data: upd, error } = await supabase.from("units").update(patch).eq("id", unit.id).is("contract_id", null).select("id");
  if (error) return fail(error.message);
  if (!upd?.length) return fail("Ta rzecz ma już umowę (1 umowa na przedmiot).");
  await supabase.from("unit_events").insert({ unit_id: unit.id, type: "contract", data: { contract_id: contractId, sale_id: saleId || null, note: "gotowa umowa dołączona do sprzedaży" } });
  revalidatePath("/sprzedaz");
  revalidatePath("/umowy");
  redirect(`${back}${back.includes("?") ? "&" : "?"}ok=${encodeURIComponent(`Umowa ${c.number ? `nr ${c.number} ` : ""}przypisana.`)}`);
}

/** JPK: pobranie z Base paragonów, których brakuje w naszym systemie. */
export async function fetchMissingReceipts(formData: FormData) {
  await requireProfile();
  const db = createAdminClient();
  const back = String(formData.get("back") ?? "/sprzedaz?widok=jpk");
  const ids = String(formData.get("base_orders") ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
  let msg: string;
  let ok = true;
  try {
    const synced = await syncBaseReceipts(db);
    const r = ids.length ? await fetchReceiptsForOrders(db, ids) : { checked: 0, found: 0 };
    msg = `Base: nowych paragonów ${synced.receipts}, do brakujących zamówień znaleziono ${r.found} z ${r.checked}.`;
  } catch (e) {
    ok = false;
    msg = `Base: ${e instanceof Error ? e.message : String(e)}`;
  }
  revalidatePath("/sprzedaz");
  redirect(`${back.startsWith("/sprzedaz") ? back : "/sprzedaz?widok=jpk"}&${ok ? "ok" : "blad"}=${encodeURIComponent(msg)}`);
}
