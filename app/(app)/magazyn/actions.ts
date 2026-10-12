"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { runAutoCatalog } from "@/lib/sync/auto-catalog";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin, requireProfile } from "@/lib/auth";
import { adjustStock, type StockChange } from "@/lib/stock";
import { parseAmount } from "@/lib/contracts/upload";
import { errorMessage } from "@/lib/errors";

/** Statusy, które Base liczy w stanie magazynu. */
const COUNTED = ["in_stock", "reserved"];

function back(path: string, msg: string, tone: "ok" | "error" = "ok"): never {
  const sep = path.includes("?") ? "&" : "?";
  redirect(`${path}${sep}${tone === "ok" ? "ok" : "blad"}=${encodeURIComponent(msg)}`);
}

function baseSummary(results: { ok: boolean; message: string }[]) {
  const failed = results.filter((r) => !r.ok);
  if (!results.length) return "";
  return failed.length ? ` Uwaga, stan w Shopify nie zaktualizowany: ${failed.map((f) => f.message).join("; ")}` : " Stan w Shopify zaktualizowany.";
}

/** Akcje zbiorcze z listy Magazyn. */
export async function bulkAction(formData: FormData) {
  const { supabase, profile } = await requireProfile();
  const ids = formData.getAll("ids").map(String).filter(Boolean);
  const action = String(formData.get("action") ?? "");
  const returnTo = String(formData.get("returnTo") ?? "/magazyn");
  if (!ids.length) back(returnTo, "Zaznacz sztuki na liście.", "error");

  const { data: units, error } = await supabase.from("units").select("id, status, variant_id, location_id").in("id", ids);
  if (error) back(returnTo, error.message, "error");

  if (action === "move") {
    const locationId = String(formData.get("location_id") ?? "");
    if (!locationId) back(returnTo, "Wybierz lokalizację docelową.", "error");
    const { data: locs } = await supabase.from("locations").select("id, base_warehouse_id");
    const wh = new Map((locs ?? []).map((l) => [l.id as string, l.base_warehouse_id as string | null]));
    const changes: StockChange[] = [];
    for (const u of units!) {
      // Stan w Base zmienia się tylko, gdy sztuka na stanie zmienia magazyn Base.
      if (u.location_id === locationId || !COUNTED.includes(u.status)) continue;
      if (wh.get(u.location_id) === wh.get(locationId)) continue;
      changes.push({ variantId: u.variant_id, locationId: u.location_id, delta: -1 });
      changes.push({ variantId: u.variant_id, locationId, delta: 1 });
    }
    const moved = units!.filter((u) => u.location_id !== locationId);
    const { error: e } = await supabase.from("units").update({ location_id: locationId }).in("id", moved.map((u) => u.id));
    if (e) back(returnTo, e.message, "error");
    await supabase.from("unit_events").insert(moved.map((u) => ({ unit_id: u.id, type: "moved", data: { from: u.location_id, to: locationId } })));
    const results = await adjustStock(supabase, changes);
    revalidatePath("/magazyn");
    back(returnTo, `Przeniesiono ${moved.length} szt.${baseSummary(results)}`, results.some((r) => !r.ok) ? "error" : "ok");
  }

  if (action === "contract") {
    const contractId = String(formData.get("contract_id") ?? "") || null;
    const { error: e } = await supabase.from("units").update({ contract_id: contractId }).in("id", ids);
    if (e) back(returnTo, e.message, "error");
    await supabase.from("unit_events").insert(ids.map((id) => ({ unit_id: id, type: "contract", data: { contract_id: contractId } })));
    revalidatePath("/magazyn");
    back(returnTo, contractId ? `Przypięto umowę do ${ids.length} szt.` : `Odpięto umowę od ${ids.length} szt.`);
  }

  if (action === "receive") {
    // Towar „w drodze”: sztuki pod zamówienie od razu sprzedane, reszta na stan (+1 w Base).
    const { data: received, error: e } = await supabase.rpc("receive_in_transit", { p_unit_ids: ids });
    if (e) back(returnTo, e.message, "error");
    const rows = (received ?? []) as { unit_id: string; variant_id: string; location_id: string; to_status: string }[];
    if (!rows.length) back(returnTo, "Żadna z zaznaczonych sztuk nie jest „w drodze”.", "error");
    const toStock = rows.filter((r) => r.to_status === "in_stock");
    const results = await adjustStock(supabase, toStock.map((u) => ({ variantId: u.variant_id, locationId: u.location_id, delta: 1 })));
    revalidatePath("/magazyn");
    const forOrders = rows.length - toStock.length;
    back(returnTo, `Przyjęto ${rows.length} szt.: na stan ${toStock.length}${forOrders ? `, do zamówień ${forOrders} (sprzedane)` : ""}.${baseSummary(results)}`, results.some((r) => !r.ok) ? "error" : "ok");
  }

  if (action === "consignor_return") {
    // Wysyłka do komisanta: rzecz komisowa wychodzi z magazynu (stan w Shopify −1), historia zostaje w karcie sztuki.
    const { data: cons } = await supabase.from("units").select("id, status, owner_type, variant_id, location_id, consignor_id").in("id", ids);
    // Rzeczy ze zleceniem wysyłki od komisanta obsługuje się w Komisanci (stan w Shopify już zdjęty).
    const { data: openReq } = await supabase.from("consignor_shipments").select("unit_ids").eq("status", "requested");
    const requested = new Set((openReq ?? []).flatMap((r) => r.unit_ids as string[]));
    if (ids.some((x) => requested.has(x))) back(returnTo, "Część zaznaczonych rzeczy ma zlecenie wysyłki od komisanta – oznacz je jako wysłane w Komisanci.", "error");
    const ok = (cons ?? []).filter((u) => u.owner_type === "consignment" && ["in_stock", "reserved", "returned"].includes(u.status as string));
    if (!ok.length) back(returnTo, "Zaznacz rzeczy komisowe, które są na stanie.", "error");
    // Zmiana tylko, gdy status się w międzyczasie nie zmienił (np. komisant właśnie zlecił wysyłkę).
    const changed: typeof ok = [];
    for (const st of ["in_stock", "reserved", "returned"]) {
      const group = ok.filter((u) => u.status === st);
      if (!group.length) continue;
      const { data: upd, error: e } = await supabase.from("units").update({ status: "consignor_returned" }).in("id", group.map((u) => u.id)).eq("status", st).select("id");
      if (e) back(returnTo, e.message, "error");
      const done = new Set((upd ?? []).map((u) => u.id as string));
      changed.push(...group.filter((u) => done.has(u.id as string)));
    }
    await supabase.from("unit_events").insert(changed.map((u) => ({ unit_id: u.id, type: "consignor_returned", data: { consignor_id: u.consignor_id, note: "wysyłka do komisanta" } })));
    const counted = changed.filter((u) => COUNTED.includes(u.status as string));
    const results = await adjustStock(supabase, counted.map((u) => ({ variantId: u.variant_id as string, locationId: u.location_id as string, delta: -1 })));
    revalidatePath("/magazyn");
    const skipped = ids.length - ok.length;
    back(returnTo, `Oddano komisantowi ${changed.length} szt.${skipped || ok.length > changed.length ? ` Pominięto ${skipped + ok.length - changed.length} (nie komis albo nie na stanie).` : ""}${baseSummary(results)}`, results.some((r) => !r.ok) ? "error" : "ok");
  }

  if (action === "delete") {
    // Usuwanie z aplikacji (np. pomyłki, usługi z importu) – tylko administrator, stan w Base bez zmian.
    if (profile.role !== "admin") back(returnTo, "Usuwać sztuki może tylko administrator.", "error");
    const { data: sold } = await supabase.from("sales").select("unit_id").in("unit_id", ids);
    const blocked = new Set((sold ?? []).map((s) => s.unit_id as string));
    const toDelete = ids.filter((id) => !blocked.has(id));
    if (toDelete.length) {
      const { error: e } = await supabase.from("units").delete().in("id", toDelete);
      if (e) back(returnTo, e.message, "error");
    }
    revalidatePath("/magazyn");
    back(returnTo, `Usunięto ${toDelete.length} szt. Stan w Base bez zmian.${blocked.size ? ` ${blocked.size} szt. ze sprzedażą pominięto.` : ""}`);
  }

  back(returnTo, "Nieznana akcja.", "error");
}

/** Edycja danych sztuki (karta sztuki). */
export async function updateUnit(formData: FormData) {
  const { supabase, profile } = await requireProfile();
  const id = String(formData.get("id"));
  const path = `/magazyn/${id}`;
  const ownerType = String(formData.get("owner_type") ?? "own");
  const patch: Record<string, unknown> = {
    identifier: String(formData.get("identifier") ?? "").trim().toUpperCase() || null,
    shelf: String(formData.get("shelf") ?? "").trim() || null,
    notes: String(formData.get("notes") ?? "").trim() || null,
    contract_id: String(formData.get("contract_id") ?? "") || null,
    owner_type: ownerType,
    consignor_id: ownerType === "consignment" ? String(formData.get("consignor_id") ?? "") || null : null,
    purchase_form: String(formData.get("purchase_form")) === "vat_23" ? "vat_23" : "vat_margin",
  };
  if (profile.can_see_prices) {
    try {
      patch.purchase_price = parseAmount(formData.get("purchase_price"));
      patch.payout_amount = parseAmount(formData.get("payout_amount"));
    } catch (e) {
      back(path, errorMessage(e), "error");
    }
  }
  if (ownerType === "consignment" && !patch.consignor_id) back(path, "Wybierz komisanta.", "error");

  const { data: before } = await supabase.from("units").select("*").eq("id", id).single();
  const { error } = await supabase.from("units").update(patch).eq("id", id);
  if (error) back(path, error.message, "error");
  const changed = Object.fromEntries(Object.entries(patch).filter(([k, v]) => String(before?.[k] ?? "") !== String(v ?? "")));
  if (Object.keys(changed).length) {
    await supabase.from("unit_events").insert({ unit_id: id, type: changed.contract_id !== undefined ? "contract" : "edited", data: changed });
  }
  revalidatePath(path);
  back(path, "Zapisano.");
}

/** Zmiana statusu z karty sztuki, z korektą stanu w Base tam, gdzie to potrzebne. */
export async function changeStatus(formData: FormData) {
  const { supabase } = await requireProfile();
  const id = String(formData.get("id"));
  const to = String(formData.get("to"));
  const path = `/magazyn/${id}`;
  const { data: u } = await supabase.from("units").select("id, status, variant_id, location_id").eq("id", id).single();
  if (!u) back(path, "Nie ma takiej sztuki.", "error");

  // Zwroty idą przez funkcję w bazie, która zamyka sprzedaż.
  if ((to === "return_to_stock" || to === "returned") && ["sold", "shipped", "returned"].includes(u!.status)) {
    const { error } = await supabase.rpc("return_unit", { p_unit_id: id, p_back_to_stock: to === "return_to_stock" });
    if (error) back(path, error.message, "error");
    const results = to === "return_to_stock" ? await adjustStock(supabase, [{ variantId: u!.variant_id, locationId: u!.location_id, delta: 1 }]) : [];
    revalidatePath(path);
    back(path, `Zwrot zapisany.${baseSummary(results)}`, results.some((r) => !r.ok) ? "error" : "ok");
  }

  // Przyjęcie towaru w drodze (także pod zamówienie) – przez funkcję w bazie.
  if (u!.status === "in_transit" && to === "in_stock") {
    const { data: received, error } = await supabase.rpc("receive_in_transit", { p_unit_ids: [id] });
    if (error) back(path, error.message, "error");
    const row = ((received ?? []) as { to_status: string }[])[0];
    const results = row?.to_status === "in_stock" ? await adjustStock(supabase, [{ variantId: u!.variant_id, locationId: u!.location_id, delta: 1 }]) : [];
    revalidatePath(path);
    back(path, row?.to_status === "reserved" || row?.to_status === "sold" ? "Sztuka dotarła i jest zarezerwowana pod zamówienie (sprzedana po paragonie / fakturze)." : `Przyjęto na stan.${baseSummary(results)}`, results.some((r) => !r.ok) ? "error" : "ok");
  }

  // Rezerwacja pod zamówienie ze sklepu zdejmuje się tylko anulowaniem zamówienia.
  if (u!.status === "reserved") {
    const { count } = await supabase.from("sales").select("id", { count: "exact", head: true }).eq("unit_id", id).eq("status", "assigned");
    if (count) back(path, "Ta sztuka jest zarezerwowana pod zamówienie – zmienia się przez zamówienie (paragon albo anulowanie).", "error");
  }

  // Wydanie poza sklepem: sztuka znika z magazynu (historia zostaje), umowa wraca do niewykorzystanych.
  if (to === "out" && (u!.status === "in_stock" || u!.status === "reserved")) {
    const { data: full } = await supabase.from("units").select("contract_id").eq("id", id).single();
    const { data: done, error } = await supabase.from("units").update({ status: "removed", contract_id: null, sold_at: new Date().toISOString() })
      .eq("id", id).eq("status", u!.status).select("id");
    if (error) back(path, error.message, "error");
    if (!done?.length) back(path, "Status sztuki zmienił się w międzyczasie. Odśwież i spróbuj ponownie.", "error");
    await supabase.from("unit_events").insert({ unit_id: id, type: "status", data: { from: u!.status, to: "removed", reason: "wydana poza sklepem", contract_id: full?.contract_id ?? null } });
    if (full?.contract_id) {
      const { count } = await supabase.from("units").select("id", { count: "exact", head: true }).eq("contract_id", full.contract_id);
      if (!count) await supabase.from("contracts").update({ sale_id: null }).eq("id", full.contract_id);
    }
    const results = u!.status === "in_stock" ? await adjustStock(supabase, [{ variantId: u!.variant_id, locationId: u!.location_id, delta: -1 }]) : [];
    revalidatePath("/magazyn");
    back("/magazyn", `Sztuka wydana poza sklepem i usunięta z magazynu.${full?.contract_id ? " Umowa jest znowu na liście niewykorzystanych." : ""}${baseSummary(results)}`, results.some((r) => !r.ok) ? "error" : "ok");
  }

  // Dozwolone przejścia i ich wpływ na stan w Shopify (rezerwacja = −1, bo w sklepie nie można jej już kupić).
  const rules: Record<string, Record<string, number>> = {
    in_transit: { in_stock: 1 },
    in_stock: { reserved: -1, shipped: -1, in_transit: -1 },
    reserved: { in_stock: 1, shipped: 0 },
    sold: { shipped: 0 },
    returned: { in_stock: 1 },
  };
  const delta = rules[u!.status]?.[to];
  if (delta === undefined) back(path, "Taka zmiana statusu nie jest możliwa.", "error");
  const patch: Record<string, unknown> = { status: to };
  if (to === "in_stock" && u!.status === "in_transit") patch.received_at = new Date().toISOString();
  if (to === "shipped" && u!.status !== "sold") patch.sold_at = new Date().toISOString();
  const { data: updated, error } = await supabase.from("units").update(patch).eq("id", id).eq("status", u!.status).select("id");
  if (error) back(path, error.message, "error");
  if (!updated?.length) back(path, "Status sztuki zmienił się w międzyczasie (np. sprzedaż z Base). Odśwież i spróbuj ponownie.", "error");
  await supabase.from("unit_events").insert({ unit_id: id, type: "status", data: { from: u!.status, to } });
  const results = delta ? await adjustStock(supabase, [{ variantId: u!.variant_id, locationId: u!.location_id, delta }]) : [];
  revalidatePath(path);
  back(path, `Status zmieniony.${baseSummary(results)}`, results.some((r) => !r.ok) ? "error" : "ok");
}

/** Usunięcie sztuki dodanej przez pomyłkę (tylko administrator, tylko bez sprzedaży). */
export async function deleteUnit(formData: FormData) {
  const { supabase } = await requireAdmin();
  const id = String(formData.get("id"));
  const { data: u } = await supabase.from("units").select("id, status, variant_id, location_id").eq("id", id).single();
  const { count } = await supabase.from("sales").select("id", { count: "exact", head: true }).eq("unit_id", id);
  if (!u) back("/magazyn", "Nie ma takiej sztuki.", "error");
  if (count) back(`/magazyn/${id}`, "Ta sztuka ma sprzedaż – nie można jej usunąć. Zmień status zamiast usuwać.", "error");
  const { error } = await supabase.from("units").delete().eq("id", id);
  if (error) back(`/magazyn/${id}`, error.message, "error");
  const results = COUNTED.includes(u!.status) ? await adjustStock(supabase, [{ variantId: u!.variant_id, locationId: u!.location_id, delta: -1 }]) : [];
  revalidatePath("/magazyn");
  back("/magazyn", `Sztuka usunięta.${baseSummary(results)}`, results.some((r) => !r.ok) ? "error" : "ok");
}

/** Ręczne uruchomienie automatu: nowe produkty ze Shopify / Base i stany (Shopify ↔ aplikacja). */
export async function runAutoCatalogNow() {
  await requireAdmin();
  const db = createAdminClient();
  let msg: string;
  let ok = true;
  try {
    const r = await runAutoCatalog(db, true);
    const sum = (vals: unknown[], key: "created" | "changed" | "removed" | "waiting" | "withdrawn") => vals.reduce<number>((n, x) => n + (typeof x === "object" && x && key in x ? Number((x as Record<string, unknown>)[key]) || 0 : 0), 0);
    const pendingShops = r?.shopify.__pending ?? 0;
    const products = Object.entries(r?.shopify ?? {}).filter(([k]) => k !== "__pending").reduce((n, [, x]) => n + x, 0);
    const stockVals = Object.values(r?.stock.result ?? {});
    const stockMsg = r?.stock.master === "app"
      ? `zmieniono ${sum(stockVals, "changed")} stanów w Shopify (główny: magazyn aplikacji)`
      : `ze stanów Shopify: dodano ${sum(stockVals, "created")}, usunięto ${sum(stockVals, "removed")}, wycofano ${sum(stockVals, "withdrawn")} sztuk (czeka na potwierdzenie: ${sum(stockVals, "waiting")})`;
    const catalogMsg = pendingShops
      ? `Katalog Shopify: odczytano ${products} zmienionych produktów, reszta dojdzie przy kolejnym kliknięciu albo odczycie co 15 min`
      : products
        ? `Katalog Shopify aktualny – od ostatniego sprawdzenia zmieniło się ${products} ${products === 1 ? "produkt" : "produktów"}`
        : "Katalog Shopify aktualny – od ostatniego sprawdzenia nic się nie zmieniło";
    msg = `${catalogMsg}. Base: ${r?.base.added ?? 0} nowych. Stany wszystkich rozmiarów porównane z Shopify – ${stockMsg.replace(/^ze stanów Shopify: /, "")}.`;
    await db.from("sync_log").insert({ job: "auto-catalog", ok: true, message: JSON.stringify(r) });
  } catch (e) {
    ok = false;
    msg = errorMessage(e);
    await db.from("sync_log").insert({ job: "auto-catalog", ok: false, message: msg });
    if (/za dużo na automat/.test(msg)) msg += " Jeśli to zamierzone, wyrównaj stan w Ustawienia → Stany magazynowe („Wyrównaj do Shopify teraz”).";
  }
  revalidatePath("/magazyn");
  redirect(`/magazyn?${ok ? "ok" : "blad"}=${encodeURIComponent(msg)}`);
}
