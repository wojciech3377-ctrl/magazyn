import "server-only";
import { allPages } from "@/lib/supabase/paging";
import type { SupabaseClient } from "@supabase/supabase-js";
import { addTrackingToFulfillment, fulfillWithTracking, getOrder, ordersUpdatedSince, type ShopifyOrder } from "@/lib/integrations/shopify";
import { getPackage, listPackages, type FurgonetkaPackage } from "@/lib/integrations/furgonetka";
import { computeOrderStatus, detectCod, detectPickupPoint, type Fulfillment, type OrderForStatus, type ShipmentLike } from "@/lib/orders/status";
import { isExcluded, loadExclusions, type Exclusions } from "@/lib/services";
import { errorMessage } from "@/lib/errors";

const FIRST_RUN_DAYS = 45;

export type LineItem = {
  id: string;
  title: string;
  variant_title: string | null;
  sku: string | null;
  quantity: number;
  image: string | null;
  shopify_variant_id: string | null;
  price: number;
  service: boolean;
  /** Produkt wykluczony z magazynu robiony z pary z magazynu (np. AF1 „Rope Laces” z AF1 Low White): oryginalny wariant Shopify. */
  made_from?: string | null;
};

function toRow(storeId: string, o: ShopifyOrder, ex: Exclusions) {
  const method = o.shippingLine?.title ?? null;
  const addr = o.shippingAddress;
  const lines: LineItem[] = o.lineItems.nodes.map((l) => ({
    id: l.id,
    title: l.title,
    variant_title: l.variantTitle,
    sku: l.sku,
    quantity: l.quantity,
    image: l.image?.url ?? null,
    shopify_variant_id: l.variant?.id ?? null,
    // Cena po rabatach (to zapłacił klient).
    price: Number((l.discountedUnitPriceAfterAllDiscountsSet ?? l.originalUnitPriceSet).shopMoney.amount),
    service: isExcluded(ex, [l.sku], l.title),
  }));
  const fulfillments: Fulfillment[] = o.fulfillments.map((f) => ({
    status: f.status,
    displayStatus: f.displayStatus,
    createdAt: f.createdAt,
    trackingInfo: f.trackingInfo,
  }));
  // Zwroty pieniędzy: zakończone (SUCCESS) i w toku (PENDING), oraz ile sztuk każdej pozycji zwrócono.
  let refunded = 0;
  let pending = 0;
  const refundedLines: Record<string, number> = {};
  for (const r of o.refunds ?? []) {
    for (const t of r.transactions.nodes) {
      if (t.kind !== "REFUND") continue;
      const amount = Number(t.amountSet.shopMoney.amount);
      if (t.status === "SUCCESS") refunded += amount;
      else if (t.status === "PENDING") pending += amount;
    }
    for (const li of r.refundLineItems.nodes) if (li.lineItem) refundedLines[li.lineItem.id] = (refundedLines[li.lineItem.id] ?? 0) + li.quantity;
  }
  return {
    row: {
      store_id: storeId,
      return_status: o.returnStatus ?? null,
      refunded_amount: Math.round(refunded * 100) / 100,
      refund_pending: Math.round(pending * 100) / 100,
      refunded_lines: refundedLines,
      shopify_order_id: o.id,
      shopify_legacy_id: o.legacyResourceId,
      name: o.name,
      number: o.name.replace(/^#/, ""),
      ordered_at: o.createdAt,
      shop_updated_at: o.updatedAt,
      cancelled_at: o.cancelledAt,
      closed_at: o.closedAt,
      customer_name: addr?.name ?? o.billingAddress?.name ?? null,
      email: o.email,
      phone: addr?.phone ?? o.phone,
      shipping_address: addr,
      shipping_method: method,
      shipping_price: o.shippingLine ? Number((o.shippingLine.discountedPriceSet ?? o.shippingLine.originalPriceSet).shopMoney.amount) : null,
      pickup_point: detectPickupPoint(method, o.customAttributes, addr),
      payment_gateways: o.paymentGatewayNames,
      financial_status: o.displayFinancialStatus,
      cod: detectCod(o.paymentGatewayNames, method),
      total: Number(o.totalPriceSet.shopMoney.amount),
      outstanding: o.totalOutstandingSet ? Number(o.totalOutstandingSet.shopMoney.amount) : null,
      currency: o.totalPriceSet.shopMoney.currencyCode,
      note: o.note,
      attributes: o.customAttributes,
      line_items: lines,
      fulfillments,
      synced_at: new Date().toISOString(),
    },
  };
}

/** Zapis zamówień Shopify do bazy. */
export async function saveShopifyOrders(db: SupabaseClient, storeId: string, orders: ShopifyOrder[], ex?: Exclusions): Promise<string[]> {
  const exclusions = ex ?? (await loadExclusions(db));
  try {
    return await saveOrderBatch(db, storeId, orders, exclusions);
  } catch (e) {
    if (orders.length <= 1) throw new Error(`${orders[0]?.name ?? "zamówienie"}: ${errorMessage(e)}`);
    // Jedno wadliwe zamówienie (np. anulowane z nietypową sztuką) nie może blokować pozostałych – zapis po jednym.
    const ids: string[] = [];
    const errors: string[] = [];
    for (const o of orders) {
      try {
        ids.push(...(await saveOrderBatch(db, storeId, [o], exclusions)));
      } catch (err) {
        errors.push(`${o.name}: ${errorMessage(err)}`);
      }
    }
    if (errors.length) await db.from("sync_log").insert({ job: "shopify-orders", ok: false, message: `Pominięte zamówienia: ${errors.join("; ")}` });
    return ids;
  }
}

async function saveOrderBatch(db: SupabaseClient, storeId: string, orders: ShopifyOrder[], exclusions: Exclusions) {
  // Wszystkie zamówienia trafiają do aplikacji – także złożone wyłącznie z produktów wykluczonych (usługi itp.);
  // wykluczone pozycje nie tworzą tylko linii sprzedaży sztuk.
  const rows = orders.map((o) => toRow(storeId, o, exclusions).row);
  if (!rows.length) return [] as string[];
  // Pary robione z butów z magazynu (np. AF1 „Rope Laces”) – pozycja jak bazowy model (sztuka z magazynu, umowa).
  const madeFrom = await mapMadeFromBase(db, storeId, rows.flatMap((r) => r.line_items));
  // Anulowane w Shopify poza aplikacją (wcześniej nieanulowane u nas) → sprzedane sztuki wracają na stan.
  const { data: before } = await db.from("orders").select("shopify_order_id, cancelled_at").in("shopify_order_id", rows.map((r) => r.shopify_order_id));
  const wasOpen = new Set((before ?? []).filter((o) => !o.cancelled_at).map((o) => o.shopify_order_id as string));
  const { data, error } = await db.from("orders").upsert(rows, { onConflict: "shopify_order_id" }).select("id, shopify_order_id, cancelled_at");
  if (error) throw error;
  const ids = (data ?? []).map((r) => r.id as string);
  for (const o of data ?? []) {
    if (o.cancelled_at && wasOpen.has(o.shopify_order_id as string)) {
      const { error: relErr } = await db.rpc("release_order_sales", { p_order_id: o.id });
      if (relErr) throw relErr;
    }
  }
  await refreshOrderStatus(db, ids);
  // Nowe zamówienia: linie sprzedaży i sztuki z magazynu od razu ze Shopify.
  const startedAt = new Date(Date.now() - 2000).toISOString();
  const { error: salesErr } = await db.rpc("register_shopify_sales", { p_order_ids: ids });
  if (salesErr) throw salesErr;
  // Para z magazynu zużyta na produkt „z bazowego modelu”: w Shopify stan bazowego modelu nie spadł sam – zdejmujemy.
  if (madeFrom.size) await settleMadeFromStock(db, ids, startedAt).catch(() => null);
  return ids;
}

/**
 * Pozycja wykluczona z magazynu (np. „Nike Air Force 1 Low Black "Black Rope Laces"”, SKU CW2288-001-BLACK-ROPE-…),
 * która jest robiona z pary z magazynu: model bazowy po początku SKU (CW2288-001) i rozmiarze. Pozycja dostaje
 * wariant bazowego modelu – sztuka z magazynu, umowa, paragon jak zwykły but; produkt nadal nie jest w Magazynie.
 */
async function mapMadeFromBase(db: SupabaseClient, storeId: string, lines: LineItem[]) {
  const done = new Set<string>();
  const todo = lines.filter((l) => l.service && l.sku && /^[A-Z0-9]{3,}-[A-Z0-9]{3}-/i.test(l.sku) && l.variant_title);
  if (!todo.length) return done;
  const { normOption } = await import("@/lib/unassigned");
  const cache = new Map<string, string | null>();
  for (const l of todo) {
    const base = l.sku!.split("-").slice(0, 2).join("-").toUpperCase();
    const size = normOption(l.variant_title!.split("/").pop());
    const key = `${base}|${size}`;
    if (!cache.has(key)) {
      const { data: links } = await db.from("variant_store_links")
        .select("shopify_variant_id, sku, variant:variants!inner(id, option, product:products!inner(title, unassigned))")
        .eq("store_id", storeId).eq("inventory_tracked", true).ilike("sku", `%${base}%`).limit(200);
      type Row = { shopify_variant_id: string | null; sku: string | null; variant: { id: string; option: string; product: { title: string; unassigned: boolean | null } } };
      const hit = ((links ?? []) as unknown as Row[]).filter((x) =>
        x.shopify_variant_id && !x.variant.product.unassigned && normOption(x.variant.option) === size
        && (x.sku ?? "").toUpperCase().split(/[/\s,;]+/).some((t) => t === base || t.startsWith(`${base}-`)));
      // Kilka produktów z tym SKU (np. osobne używane pary) – ten, który ma sztuki na stanie.
      let pick = hit[0] ?? null;
      if (hit.length > 1) {
        const { data: st } = await db.from("units").select("variant_id").in("variant_id", hit.map((h) => h.variant.id)).eq("status", "in_stock");
        const withStock = new Set((st ?? []).map((u) => u.variant_id as string));
        pick = hit.find((h) => withStock.has(h.variant.id)) ?? pick;
      }
      cache.set(key, pick?.shopify_variant_id ?? null);
    }
    const gid = cache.get(key);
    if (!gid) continue;
    l.made_from = l.shopify_variant_id;
    l.shopify_variant_id = gid;
    l.service = false;
    done.add(l.id);
  }
  return done;
}

/** Sztuki z magazynu przypięte w tym przebiegu do pozycji „z bazowego modelu” – stan w Shopify bazowego modelu −1. */
async function settleMadeFromStock(db: SupabaseClient, orderIds: string[], since: string) {
  const { data: orders } = await db.from("orders").select("id, line_items").in("id", orderIds);
  const lineIds = new Set((orders ?? []).flatMap((o) => ((o.line_items ?? []) as LineItem[]).filter((l) => l.made_from).map((l) => l.id)));
  if (!lineIds.size) return;
  const { data: sales } = await db.from("sales").select("variant_id, shopify_line_id, unit:units(location_id)")
    .in("order_id", orderIds).gte("created_at", since).not("unit_id", "is", null);
  const changes = ((sales ?? []) as unknown as { variant_id: string; shopify_line_id: string | null; unit: { location_id: string } | null }[])
    .filter((x) => x.shopify_line_id && lineIds.has(x.shopify_line_id) && x.unit)
    .map((x) => ({ variantId: x.variant_id, locationId: x.unit!.location_id, delta: -1 }));
  if (!changes.length) return;
  const { getStockMaster, pushStockToShopify } = await import("@/lib/sync/shopify-stock");
  if ((await getStockMaster(db)) === "app") await pushStockToShopify(db, 500, new Set(changes.map((c) => c.variantId)));
  else await (await import("@/lib/stock")).adjustStock(db, changes);
}

/** Odczyt zamówień ze sklepów Shopify zmienionych od ostatniego razu. */
export async function syncShopifyOrders(db: SupabaseClient, maxPages = 6, rereadDays = 0) {
  const { data: stores } = await db.from("stores").select("id, code, name, shopify_domain").not("shopify_domain", "is", null);
  const exclusions = await loadExclusions(db);
  const result: Record<string, number | string> = {};
  for (const s of stores ?? []) {
    const key = `shopify_orders:${s.id}`;
    const { data: st } = await db.from("sync_state").select("value").eq("key", key).maybeSingle();
    let since = (st?.value as { since?: string } | null)?.since ?? new Date(Date.now() - FIRST_RUN_DAYS * 86400_000).toISOString();
    // Ręczne „Pobierz zamówienia teraz”: ponowny odczyt ostatnich dni (np. zamówienia wcześniej pominięte).
    if (rereadDays > 0) {
      const back = new Date(Date.now() - rereadDays * 86400_000).toISOString();
      if (back < since) since = back;
    }
    let after: string | null = null;
    let count = 0;
    try {
      for (let page = 0; page < maxPages; page++) {
        const batch = await ordersUpdatedSince(s.shopify_domain as string, s.code as string, since, after);
        await saveShopifyOrders(db, s.id as string, batch.nodes, exclusions);
        count += batch.nodes.length;
        const maxUpdated = batch.nodes.reduce((m, o) => (o.updatedAt > m ? o.updatedAt : m), since);
        if (!batch.pageInfo.hasNextPage) {
          since = maxUpdated;
          break;
        }
        after = batch.pageInfo.endCursor;
        // Przy przerwaniu w połowie (limit stron) następny przebieg zacznie od ostatniej zapisanej zmiany.
        since = maxUpdated;
      }
      await db.from("sync_state").upsert({ key, value: { since }, updated_at: new Date().toISOString() });
      result[s.name as string] = count;
    } catch (e) {
      result[s.name as string] = `błąd: ${errorMessage(e)}`;
    }
  }
  const { data: linked } = await db.rpc("link_sales_to_orders");
  result.linked = Number(linked ?? 0);
  const failed = Object.entries(result).filter(([, v]) => typeof v === "string");
  if (failed.length) throw new Error(failed.map(([k, v]) => `${k}: ${v}`).join("; "));
  return result;
}

/** Przelicza status zamówień (Nowe / Wysłane / Dostarczone / Problem) z realizacji i przesyłek. */
export async function refreshOrderStatus(db: SupabaseClient, orderIds: string[]) {
  for (let i = 0; i < orderIds.length; i += 200) {
    const ids = orderIds.slice(i, i + 200);
    const [{ data: orders }, { data: ships }] = await Promise.all([
      db.from("orders").select("id, status, status_detail, cancelled_at, closed_at, fulfillments, shipping_method, financial_status, return_status, refunded_amount, refund_pending, refunded_lines, line_items, total").in("id", ids),
      db.from("shipments").select("order_id, state, state_description, state_at, tracking_number").in("order_id", ids),
    ]);
    const byOrder = new Map<string, ShipmentLike[]>();
    for (const s of ships ?? []) byOrder.set(s.order_id as string, [...(byOrder.get(s.order_id as string) ?? []), s as ShipmentLike]);
    for (const o of orders ?? []) {
      const next = computeOrderStatus(o as unknown as OrderForStatus, byOrder.get(o.id) ?? []);
      if (next.status !== o.status || next.detail !== o.status_detail) {
        await db.from("orders").update({
          status: next.status,
          status_detail: next.detail,
          ...(next.status !== o.status ? { status_changed_at: new Date().toISOString() } : {}),
        }).eq("id", o.id);
      }
    }
  }
}

function shipmentRow(p: FurgonetkaPackage, orderId: string | null) {
  const parcel = p.parcels?.[0];
  return {
    provider: "furgonetka",
    external_id: String(p.package_id),
    order_id: orderId,
    service: parcel?.service ?? p.service ?? null,
    tracking_number: parcel?.package_no ?? null,
    tracking_url: parcel?.tracking_url ?? null,
    state: parcel?.state ?? p.state ?? null,
    state_description: parcel?.state_description ?? null,
    state_at: parcel?.datetime_status ?? null,
    reference: p.order_number ?? p.user_reference_number ?? null,
    raw: { service_id: p.service_id ?? null, receiver: p.receiver ? { name: p.receiver.name ?? null, point: p.receiver.point ?? null } : null },
    updated_at: new Date().toISOString(),
  };
}

/**
 * Stany przesyłek z Furgonetki: ostatnie paczki z konta (także robione ręcznie w panelu Furgonetki)
 * łączone z zamówieniem po numerze przesyłki albo numerze zamówienia, plus paczki utworzone w aplikacji.
 */
export async function syncFurgonetkaShipments(db: SupabaseClient, pages = 3) {
  const since = new Date(Date.now() - 60 * 86400_000).toISOString();
  // Najpierw paczki z Furgonetki, potem tylko potrzebne wiersze z bazy (co minutę – bez czytania całej tabeli przesyłek).
  const packages: Awaited<ReturnType<typeof listPackages>>["packages"] = [];
  let last: string | null = null;
  for (let page = 0; page < pages; page++) {
    const r = await listPackages(db, { limit: 50, lastPackageId: last });
    packages.push(...r.packages);
    if (!r.hasMore || !r.last) break;
    last = r.last;
  }
  const seen = new Set(packages.map((p) => String(p.package_id)));
  const [recentOrders, { data: knownSeen }, { data: knownOpen }] = await Promise.all([
    // Stronami: ponad 1000 zamówień w 60 dni nie może gubić dopasowań.
    allPages<{ id: string; number: string; ordered_at: string; fulfillments: Fulfillment[] | null }>((a, b) =>
      db.from("orders").select("id, number, ordered_at, fulfillments").gte("ordered_at", since).order("id").range(a, b)),
    seen.size ? db.from("shipments").select("external_id, order_id, state").eq("provider", "furgonetka").in("external_id", [...seen]) : Promise.resolve({ data: [] }),
    // Paczki z aplikacji jeszcze w drodze (do odświeżenia, gdy nie ma ich na pierwszych stronach listy).
    db.from("shipments").select("external_id, order_id, state").eq("provider", "furgonetka").not("order_id", "is", null)
      .or("state.is.null,and(state.not.ilike.*deliver*,state.not.ilike.*cancel*)").order("created_at", { ascending: false }).limit(200),
  ]);
  const byTracking = new Map<string, string>();
  const byNumber = new Map<string, { id: string; ordered_at: string }[]>();
  for (const o of recentOrders) {
    for (const f of (o.fulfillments ?? []) as Fulfillment[]) for (const t of f.trackingInfo ?? []) if (t.number) byTracking.set(t.number.replace(/\s/g, ""), o.id);
    byNumber.set(o.number, [...(byNumber.get(o.number) ?? []), { id: o.id, ordered_at: o.ordered_at }]);
  }
  const known = [...(knownSeen ?? []), ...(knownOpen ?? [])];
  const knownMap = new Map(known.map((k) => [k.external_id as string, k]));

  const touched = new Set<string>();
  const rows: ReturnType<typeof shipmentRow>[] = [];
  for (const p of packages) {
    const id = String(p.package_id);
    const tracking = p.parcels?.[0]?.package_no?.replace(/\s/g, "") ?? "";
    const ref = String(p.order_number ?? p.user_reference_number ?? "").replace(/^#/, "").trim();
    let orderId = knownMap.get(id)?.order_id as string | null | undefined;
    if (!orderId && tracking) orderId = byTracking.get(tracking);
    if (!orderId && ref && byNumber.has(ref)) {
      // Ten sam numer w dwóch sklepach: bierzemy zamówienie złożone najbliżej przed przesyłką.
      const added = p.datetime_add ?? new Date().toISOString();
      const cands = byNumber.get(ref)!.filter((c) => c.ordered_at <= added).sort((a, b) => b.ordered_at.localeCompare(a.ordered_at));
      orderId = (cands[0] ?? byNumber.get(ref)![0]).id;
    }
    if (!orderId && !knownMap.has(id)) continue;
    rows.push(shipmentRow(p, orderId ?? null));
    if (orderId) touched.add(orderId);
  }

  // Paczki z aplikacji, których nie ma na pierwszych stronach listy, a jeszcze nie są dostarczone.
  const stale = (knownOpen ?? []).filter((k) => !seen.has(k.external_id as string) && k.order_id && !/deliver|cancel/i.test(String(k.state ?? ""))).slice(0, 15);
  for (const k of stale) {
    try {
      rows.push(shipmentRow(await getPackage(db, k.external_id as string), k.order_id as string));
      touched.add(k.order_id as string);
    } catch {
      // pojedyncza paczka nie blokuje reszty
    }
  }

  if (rows.length) {
    const { error } = await db.from("shipments").upsert(rows, { onConflict: "provider,external_id" });
    if (error) throw error;
  }
  await refreshOrderStatus(db, [...touched]);
  return { packages: rows.length, orders: touched.size };
}

const PENDING = "ship_fulfill:";
const carrierName = (service: string | null | undefined) => (/dpd/i.test(service ?? "") ? "DPD" : /dhl/i.test(service ?? "") ? "DHL" : /gls/i.test(service ?? "") ? "GLS" : /ups/i.test(service ?? "") ? "UPS" : /poczta|pocztex/i.test(service ?? "") ? "Poczta Polska" : "InPost");

/** Etykieta z aplikacji, której numeru nie udało się od razu wysłać do Shopify – ponowienie przy kolejnych przebiegach. */
export async function queueTrackingPush(db: SupabaseClient, shipmentId: string, notify: boolean, reason: string) {
  await db.from("sync_state").upsert({ key: `${PENDING}${shipmentId}`, value: { shipmentId, notify, reason, attempts: 0, at: new Date().toISOString() }, updated_at: new Date().toISOString() });
}

export async function clearTrackingPush(db: SupabaseClient, shipmentId: string) {
  await db.from("sync_state").delete().eq("key", `${PENDING}${shipmentId}`);
}

/**
 * Etykiety z aplikacji z ostatnich 3 dni, których numer nie trafił do Shopify (zamówienie bez realizacji z tym numerem),
 * a nie ma ich w kolejce – np. przerwane tworzenie etykiety przed wprowadzeniem kolejki. Dopisywane do kolejki.
 */
async function queueMissedTracking(db: SupabaseClient) {
  const since = new Date(Date.now() - 3 * 86400_000).toISOString();
  const { data: ships } = await db.from("shipments")
    .select("id, tracking_number, state, order:orders(shopify_order_id, cancelled_at, fulfillments)")
    .eq("provider", "furgonetka").eq("created_in_app", true).gte("created_at", since).not("order_id", "is", null).limit(100);
  for (const sh of ships ?? []) {
    const o = sh.order as unknown as { shopify_order_id: string | null; cancelled_at: string | null; fulfillments: Fulfillment[] | null } | null;
    if (!o || o.cancelled_at || !o.shopify_order_id?.startsWith("gid://") || /cancel/i.test(String(sh.state ?? ""))) continue;
    const nums = (o.fulfillments ?? []).flatMap((f) => (f.trackingInfo ?? []).map((t) => t.number));
    if (sh.tracking_number && nums.includes(sh.tracking_number as string)) continue;
    const key = `${PENDING}${sh.id}`;
    const { data: had } = await db.from("sync_state").select("key").eq("key", key).maybeSingle();
    if (had) continue;
    // Raz na przesyłkę (znacznik „sprawdzone”, żeby po porzuceniu nie wracała co minutę).
    const { data: seen } = await db.from("sync_state").select("key").eq("key", `ship_checked:${sh.id}`).maybeSingle();
    if (seen) continue;
    await db.from("sync_state").upsert({ key: `ship_checked:${sh.id}`, value: { at: new Date().toISOString() }, updated_at: new Date().toISOString() });
    await queueTrackingPush(db, sh.id as string, true, "numer nie dotarł do Shopify przy tworzeniu etykiety");
  }
}

/**
 * Numer przesyłki do Shopify (co minutę, razem z Furgonetką): realizacja z numerem, a gdy zamówienie zostało już
 * oznaczone jako wysłane bez numeru – dopisanie numeru do tej realizacji.
 */
export async function pushPendingTracking(db: SupabaseClient) {
  await queueMissedTracking(db).catch(() => null);
  const { data: pend } = await db.from("sync_state").select("key, value").like("key", `${PENDING}%`).limit(20);
  let sent = 0;
  const errors: string[] = [];
  for (const p of pend ?? []) {
    const v = p.value as { shipmentId: string; notify: boolean; attempts?: number; at: string };
    const drop = () => db.from("sync_state").delete().eq("key", p.key);
    if (Date.now() - Date.parse(v.at) > 3 * 86400_000 || (v.attempts ?? 0) >= 30) {
      await db.from("sync_log").insert({ job: "tracking-shopify", ok: false, message: `Przesyłka ${v.shipmentId}: numer nie trafił do Shopify (porzucone po ${v.attempts ?? 0} próbach).` });
      await drop();
      continue;
    }
    const { data: sh } = await db.from("shipments")
      .select("id, external_id, tracking_number, tracking_url, service, state, order:orders(id, store_id, shopify_order_id, cancelled_at, store:stores(code, shopify_domain))")
      .eq("id", v.shipmentId).maybeSingle();
    const order = sh?.order as unknown as { id: string; store_id: string; shopify_order_id: string; cancelled_at: string | null; store: { code: string; shopify_domain: string | null } | null } | null;
    if (!sh || !order || order.cancelled_at || !order.store?.shopify_domain || !order.shopify_order_id?.startsWith("gid://") || /cancel/i.test(sh.state ?? "")) { await drop(); continue; }
    try {
      let number = sh.tracking_number as string | null;
      let url = sh.tracking_url as string | null;
      if (!number) {
        const full = await getPackage(db, sh.external_id as string);
        number = full.parcels?.[0]?.package_no ?? null;
        url = full.parcels?.[0]?.tracking_url ?? url;
        if (number) await db.from("shipments").update({ tracking_number: number, tracking_url: url, updated_at: new Date().toISOString() }).eq("id", sh.id);
      }
      if (!number) throw new Error("Furgonetka nie podała jeszcze numeru przesyłki");
      const t = { number, url, company: carrierName(sh.service as string | null) };
      const note = await fulfillWithTracking(order.store.shopify_domain, order.store.code, order.shopify_order_id, t, v.notify);
      // Brak otwartych pozycji = już oznaczone jako wysłane (np. ręcznie, bez numeru) → dopisujemy numer.
      if (note && !(await addTrackingToFulfillment(order.store.shopify_domain, order.store.code, order.shopify_order_id, t, v.notify))) {
        // Wszystko już wysłane z innym numerem – nie ma gdzie dopisać; zostawiamy ślad w dzienniku.
        await db.from("sync_log").insert({ job: "tracking-shopify", ok: false, message: `Przesyłka ${number}: zamówienie w Shopify jest już zrealizowane z innym numerem – nie dopisano.` });
      }
      const fresh = await getOrder(order.store.shopify_domain, order.store.code, order.shopify_order_id);
      if (fresh) await saveShopifyOrders(db, order.store_id, [fresh]);
      await drop();
      sent++;
    } catch (e) {
      errors.push(errorMessage(e));
      await db.from("sync_state").update({ value: { ...v, attempts: (v.attempts ?? 0) + 1, error: errorMessage(e) }, updated_at: new Date().toISOString() }).eq("key", p.key);
    }
  }
  return { sent, ...(errors.length ? { errors } : {}) };
}

/**
 * Jednorazowo (z kursorem) dla zamówień zapisanych wcześniej: pozycje „z bazowego modelu” (np. AF1 Rope) dostają wariant
 * bazowego modelu – w zamówieniu i JPK jest „Dołącz umowę”. Sztuki z magazynu rezerwujemy tylko w zamówieniach
 * jeszcze niewysłanych (status „nowe”); w wysłanych umowę dołączasz ręcznie.
 */
export async function remapMadeFromOrders(db: SupabaseClient, deadline = Date.now() + 40_000) {
  const key = "made_from_remap_v1";
  const { data: st } = await db.from("sync_state").select("value").eq("key", key).maybeSingle();
  const state = (st?.value ?? {}) as { done?: boolean; after?: string };
  if (state.done) return null;
  let after = state.after ?? "1970-01-01T00:00:00Z";
  let changed = 0;
  const open: string[] = [];
  for (;;) {
    const { data, error } = await db.from("orders").select("id, store_id, status, cancelled_at, ordered_at, line_items")
      .filter("line_items", "cs", JSON.stringify([{ service: true }])).gt("ordered_at", after).order("ordered_at").limit(100);
    if (error) throw error;
    const rows = (data ?? []) as { id: string; store_id: string; status: string; cancelled_at: string | null; ordered_at: string; line_items: LineItem[] }[];
    for (const o of rows) {
      const lines = o.line_items.map((l) => ({ ...l }));
      const hit = await mapMadeFromBase(db, o.store_id, lines);
      if (hit.size) {
        await db.from("orders").update({ line_items: lines }).eq("id", o.id);
        changed++;
        if (o.status === "new" && !o.cancelled_at) open.push(o.id);
      }
      after = o.ordered_at;
    }
    const finished = rows.length < 100;
    await db.from("sync_state").upsert({ key, value: { done: finished, after }, updated_at: new Date().toISOString() });
    if (finished || Date.now() > deadline) break;
  }
  if (open.length) {
    const since = new Date(Date.now() - 2000).toISOString();
    await db.rpc("register_shopify_sales", { p_order_ids: open });
    await settleMadeFromStock(db, open, since).catch(() => null);
  }
  return { changed, open: open.length };
}
