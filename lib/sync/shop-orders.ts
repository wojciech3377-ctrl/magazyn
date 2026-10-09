import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ordersUpdatedSince, type ShopifyOrder } from "@/lib/integrations/shopify";
import { getPackage, listPackages, type FurgonetkaPackage } from "@/lib/integrations/furgonetka";
import { computeOrderStatus, detectCod, detectPickupPoint, type Fulfillment, type ShipmentLike } from "@/lib/orders/status";
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
  return {
    row: {
      store_id: storeId,
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
    onlyServices: lines.length > 0 && lines.every((l) => l.service),
  };
}

/** Zapis zamówień Shopify do bazy (bez zamówień składających się wyłącznie z usług, np. napraw). */
export async function saveShopifyOrders(db: SupabaseClient, storeId: string, orders: ShopifyOrder[], ex?: Exclusions) {
  const exclusions = ex ?? (await loadExclusions(db));
  const rows = orders.map((o) => toRow(storeId, o, exclusions)).filter((r) => !r.onlyServices).map((r) => r.row);
  if (!rows.length) return [] as string[];
  const { data, error } = await db.from("orders").upsert(rows, { onConflict: "shopify_order_id" }).select("id");
  if (error) throw error;
  const ids = (data ?? []).map((r) => r.id as string);
  await refreshOrderStatus(db, ids);
  return ids;
}

/** Odczyt zamówień ze sklepów Shopify zmienionych od ostatniego razu. */
export async function syncShopifyOrders(db: SupabaseClient, maxPages = 6) {
  const { data: stores } = await db.from("stores").select("id, code, name, shopify_domain").not("shopify_domain", "is", null);
  const exclusions = await loadExclusions(db);
  const result: Record<string, number | string> = {};
  for (const s of stores ?? []) {
    const key = `shopify_orders:${s.id}`;
    const { data: st } = await db.from("sync_state").select("value").eq("key", key).maybeSingle();
    let since = (st?.value as { since?: string } | null)?.since ?? new Date(Date.now() - FIRST_RUN_DAYS * 86400_000).toISOString();
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
      db.from("orders").select("id, status, status_detail, cancelled_at, closed_at, fulfillments, shipping_method, financial_status").in("id", ids),
      db.from("shipments").select("order_id, state, state_description, state_at, tracking_number").in("order_id", ids),
    ]);
    const byOrder = new Map<string, ShipmentLike[]>();
    for (const s of ships ?? []) byOrder.set(s.order_id as string, [...(byOrder.get(s.order_id as string) ?? []), s as ShipmentLike]);
    for (const o of orders ?? []) {
      const next = computeOrderStatus(o as { cancelled_at: string | null; closed_at: string | null; fulfillments: Fulfillment[]; shipping_method: string | null; financial_status: string | null }, byOrder.get(o.id) ?? []);
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
  const { data: recentOrders } = await db.from("orders").select("id, number, ordered_at, fulfillments").gte("ordered_at", since);
  const byTracking = new Map<string, string>();
  const byNumber = new Map<string, { id: string; ordered_at: string }[]>();
  for (const o of recentOrders ?? []) {
    for (const f of (o.fulfillments ?? []) as Fulfillment[]) for (const t of f.trackingInfo ?? []) if (t.number) byTracking.set(t.number.replace(/\s/g, ""), o.id);
    byNumber.set(o.number, [...(byNumber.get(o.number) ?? []), { id: o.id, ordered_at: o.ordered_at }]);
  }
  const { data: known } = await db.from("shipments").select("external_id, order_id, state").eq("provider", "furgonetka");
  const knownMap = new Map((known ?? []).map((k) => [k.external_id as string, k]));

  const touched = new Set<string>();
  const seen = new Set<string>();
  const rows: ReturnType<typeof shipmentRow>[] = [];
  let last: string | null = null;
  for (let page = 0; page < pages; page++) {
    const r = await listPackages(db, { limit: 50, lastPackageId: last });
    for (const p of r.packages) {
      const id = String(p.package_id);
      seen.add(id);
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
    if (!r.hasMore || !r.last) break;
    last = r.last;
  }

  // Paczki z aplikacji, których nie ma na pierwszych stronach listy, a jeszcze nie są dostarczone.
  const stale = (known ?? []).filter((k) => !seen.has(k.external_id as string) && k.order_id && !/deliver|cancel/i.test(String(k.state ?? ""))).slice(0, 15);
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
