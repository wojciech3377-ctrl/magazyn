"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin, requireProfile } from "@/lib/auth";
import { addReceipt } from "@/lib/integrations/base";
import { errorMessage } from "@/lib/errors";
import { adjustBaseStock, type StockChange } from "@/lib/stock";
import type { LineItem } from "@/lib/sync/shop-orders";
import { createAdminClient } from "@/lib/supabase/admin";
import { accountServices, cancelPackages, createPackage, deletePackage, furgonetkaConnection, getPackage, orderPackages, type Address, type NewPackage } from "@/lib/integrations/furgonetka";
import { cancelShopifyOrder, fulfillWithTracking, getOrder, refundShopifyLines, type CancelReason } from "@/lib/integrations/shopify";
import { getSender, LOCKER_SIZES, SERVICE_LABEL, type ServiceKey } from "@/lib/orders/sender";
import { refreshOrderStatus, saveShopifyOrders, syncFurgonetkaShipments } from "@/lib/sync/shop-orders";

export type LabelState = { error?: string; ok?: string; warning?: string; shipmentId?: string; tracking?: string } | null;

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const num = (fd: FormData, k: string) => {
  const v = Number(str(fd, k).replace(",", "."));
  return Number.isFinite(v) ? v : 0;
};

function normalizePhone(p: string) {
  const digits = p.replace(/[^\d+]/g, "");
  return digits.startsWith("00") ? `+${digits.slice(2)}` : digits;
}

function normalizePostcode(code: string, country: string) {
  const c = code.replace(/\s/g, "");
  return country === "PL" && /^\d{5}$/.test(c) ? `${c.slice(0, 2)}-${c.slice(2)}` : code.trim();
}

/** Etykieta z poziomu zamówienia: przesyłka w Furgonetce (InPost / DPD), nadanie, numer do Shopify. */
export async function createLabel(_: LabelState, fd: FormData): Promise<LabelState> {
  const { profile } = await requireProfile();
  const db = createAdminClient();
  const orderId = str(fd, "order_id");
  const { data: order } = await db.from("orders").select("*, store:stores(code, shopify_domain)").eq("id", orderId).maybeSingle();
  if (!order) return { error: "Nie ma takiego zamówienia." };
  if (order.cancelled_at) return { error: "Zamówienie jest anulowane." };
  if (!(await furgonetkaConnection(db))) return { error: "Aplikacja nie jest połączona z Furgonetką (Ustawienia → Wysyłka)." };

  const service = str(fd, "service") as ServiceKey;
  if (!(service in SERVICE_LABEL)) return { error: "Wybierz przewoźnika." };
  const carrier = service === "dpd" ? "dpd" : "inpost";
  const locker = service === "inpost_locker";

  const country = (str(fd, "country_code") || "PL").toUpperCase();
  const receiver: Address = {
    name: str(fd, "name"),
    company: str(fd, "company") || null,
    street: str(fd, "street"),
    postcode: normalizePostcode(str(fd, "postcode"), country),
    city: str(fd, "city"),
    country_code: country,
    email: str(fd, "email") || null,
    phone: normalizePhone(str(fd, "phone")) || null,
  };
  const point = str(fd, "point").toUpperCase();
  if (!receiver.name) return { error: "Podaj odbiorcę." };
  if (!receiver.phone) return { error: "Podaj telefon odbiorcy." };
  if (locker) {
    if (!point) return { error: "Podaj kod paczkomatu (np. WAW253M)." };
    if (!receiver.email) return { error: "Do paczkomatu potrzebny jest e-mail odbiorcy." };
    receiver.point = point;
  } else if (!receiver.street || !receiver.postcode || !receiver.city) {
    return { error: "Podaj pełny adres odbiorcy." };
  }

  const weight = num(fd, "weight") || 1;
  const size = str(fd, "size") as keyof typeof LOCKER_SIZES;
  const dims = locker
    ? LOCKER_SIZES[size] ?? LOCKER_SIZES.B
    : { width: num(fd, "width") || 25, depth: num(fd, "depth") || 35, height: num(fd, "height") || 15 };
  const value = num(fd, "value");
  const cod = num(fd, "cod");
  if (cod < 0 || value < 0) return { error: "Kwoty nie mogą być ujemne." };

  const sender = await getSender(db);
  const pickup: Address = {
    name: sender.name || null,
    company: sender.company || null,
    street: sender.street,
    postcode: sender.postcode,
    city: sender.city,
    country_code: "PL",
    email: sender.email || null,
    phone: normalizePhone(sender.phone) || null,
  };

  let services;
  try {
    services = await accountServices(db);
  } catch (e) {
    return { error: errorMessage(e) };
  }
  const svc = services.find((s) => s.service === carrier);
  if (!svc) return { error: `Na koncie Furgonetki nie ma usługi ${carrier.toUpperCase()}.` };

  const body: NewPackage = {
    pickup: carrier === "inpost" ? { ...pickup, point: sender.inpost_send_point || "any_apm" } : pickup,
    receiver,
    service_id: svc.id,
    type: "package",
    // Furgonetka przyjmuje w numerze referencyjnym tylko litery, cyfry i myślniki.
    user_reference_number: String(order.number).replace(/[^\p{L}\p{N}-]/gu, "").slice(0, 30),
    parcels: [{ width: dims.width, depth: dims.depth, height: dims.height, weight, ...(value > 0 ? { value } : {}), description: str(fd, "description") || undefined }],
    additional_services: cod > 0
      ? { cod: { amount: cod, express: false, ...(sender.cod_iban ? { iban: sender.cod_iban.replace(/\s/g, ""), name: sender.company } : {}) } }
      : {},
  };

  let packageId: string;
  try {
    const pkg = await createPackage(db, body);
    packageId = String(pkg.package_id);
  } catch (e) {
    return { error: errorMessage(e) };
  }
  const { data: ship, error: insErr } = await db.from("shipments").insert({
    order_id: order.id, provider: "furgonetka", external_id: packageId, service: carrier, reference: order.number,
    created_in_app: true, created_by: profile.id, state: "waiting",
  }).select("id").single();
  if (insErr) return { error: insErr.message };

  try {
    await orderPackages(db, [packageId]);
  } catch (e) {
    await deletePackage(db, packageId).catch(() => {});
    await db.from("shipments").delete().eq("id", ship.id);
    return { error: errorMessage(e) };
  }

  let tracking: string | null = null;
  let trackingUrl: string | null = null;
  try {
    const full = await getPackage(db, packageId);
    const parcel = full.parcels?.[0];
    tracking = parcel?.package_no ?? null;
    trackingUrl = parcel?.tracking_url ?? null;
    await db.from("shipments").update({
      tracking_number: tracking, tracking_url: trackingUrl, state: parcel?.state ?? full.state ?? "ordered",
      state_description: parcel?.state_description ?? null, state_at: parcel?.datetime_status ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", ship.id);
  } catch {
    // numer dojdzie przy następnym odczycie przesyłek
  }

  let warning: string | undefined;
  const store = order.store as { code: string; shopify_domain: string | null } | null;
  if (fd.get("fulfill") && tracking && store?.shopify_domain) {
    try {
      const note = await fulfillWithTracking(store.shopify_domain, store.code, order.shopify_order_id, {
        number: tracking, url: trackingUrl, company: carrier === "dpd" ? "DPD" : "InPost",
      }, !!fd.get("notify"));
      if (note) warning = `Shopify: ${note}.`;
      const fresh = await getOrder(store.shopify_domain, store.code, order.shopify_order_id);
      if (fresh) await saveShopifyOrders(db, order.store_id, [fresh]);
    } catch (e) {
      warning = `Etykieta jest, ale Shopify nie przyjął numeru: ${errorMessage(e)}`;
    }
  }
  await refreshOrderStatus(db, [order.id]);
  revalidatePath(`/sprzedaz/${order.id}`);
  revalidatePath("/sprzedaz");
  return { ok: "Etykieta utworzona.", shipmentId: ship.id, tracking: tracking ?? undefined, warning };
}

/** Odświeżenie jednego zamówienia ze Shopify i stanów przesyłek. */
export async function refreshOrder(fd: FormData) {
  await requireProfile();
  const db = createAdminClient();
  const id = str(fd, "id");
  const { data: order } = await db.from("orders").select("id, store_id, shopify_order_id, store:stores(code, shopify_domain)").eq("id", id).maybeSingle();
  if (!order) return;
  const store = order.store as unknown as { code: string; shopify_domain: string | null } | null;
  if (store?.shopify_domain) {
    const fresh = await getOrder(store.shopify_domain, store.code, order.shopify_order_id);
    if (fresh) await saveShopifyOrders(db, order.store_id, [fresh]);
  }
  if (await furgonetkaConnection(db)) await syncFurgonetkaShipments(db, 1).catch(() => null);
  await db.rpc("link_sales_to_orders");
  await refreshOrderStatus(db, [id]);
  revalidatePath(`/sprzedaz/${id}`);
}

export type OrderOpState = { error?: string; ok?: string; notes?: string[] } | null;

type OrderForOp = {
  id: string; store_id: string; shopify_order_id: string; name: string; cancelled_at: string | null; line_items: LineItem[];
  store: { code: string; shopify_domain: string | null } | null;
};

async function loadOrder(id: string) {
  const db = createAdminClient();
  const { data } = await db.from("orders").select("id, store_id, shopify_order_id, name, cancelled_at, line_items, store:stores(code, shopify_domain)").eq("id", id).maybeSingle();
  return data as unknown as OrderForOp | null;
}

/**
 * Sztuki z linii sprzedaży wracają na stan (+1 w Base) albo „do sprawdzenia”.
 * Linie bez sprzedanej sztuki (brak sztuki, towar w drodze) są anulowane.
 */
async function releaseSales(saleIds: string[], backToStock: boolean, notes: string[]) {
  const { supabase } = await requireProfile();
  if (!saleIds.length) return;
  const { data: sales } = await supabase.from("sales").select("id, status, unit:units(id, code, status, variant_id, location_id)").in("id", saleIds);
  const changes: StockChange[] = [];
  for (const s of sales ?? []) {
    const u = s.unit as unknown as { id: string; code: string; status: string; variant_id: string; location_id: string } | null;
    if (u && ["sold", "shipped"].includes(u.status)) {
      const { error } = await supabase.rpc("return_unit", { p_unit_id: u.id, p_back_to_stock: backToStock });
      if (error) notes.push(`${u.code}: ${error.message}`);
      else if (backToStock) changes.push({ variantId: u.variant_id, locationId: u.location_id, delta: 1 });
    } else if (s.status !== "cancelled") {
      await supabase.from("sales").update({ status: "cancelled" }).eq("id", s.id);
    }
  }
  if (changes.length) {
    for (const r of await adjustBaseStock(supabase, changes)) if (!r.ok) notes.push(`Base: ${r.message}`);
  }
}

/** Anulowanie zamówienia: Shopify (zwrot pieniędzy), etykieta w Furgonetce, sztuki z powrotem na stan. */
export async function cancelOrderAction(_: OrderOpState, fd: FormData): Promise<OrderOpState> {
  try {
    await requireAdmin();
  } catch (e) {
    return { error: errorMessage(e) };
  }
  const order = await loadOrder(str(fd, "order_id"));
  if (!order) return { error: "Nie ma takiego zamówienia." };
  if (order.cancelled_at) return { error: "Zamówienie jest już anulowane." };
  const reason = str(fd, "reason") as CancelReason;
  if (!["CUSTOMER", "DECLINED", "FRAUD", "INVENTORY", "OTHER", "STAFF"].includes(reason)) return { error: "Wybierz powód." };
  const db = createAdminClient();
  const notes: string[] = [];
  // Najpierw oznaczamy anulowanie u nas: webhook ze Shopify nie zwolni wtedy sztuk drugi raz, a podwójne kliknięcie nic nie zrobi.
  const { data: claimed } = await db.from("orders").update({ cancelled_at: new Date().toISOString() }).eq("id", order.id).is("cancelled_at", null).select("id");
  if (!claimed?.length) return { error: "Zamówienie jest już anulowane." };

  if (order.store?.shopify_domain) {
    try {
      await cancelShopifyOrder(order.store.shopify_domain, order.store.code, order.shopify_order_id, {
        reason, refund: !!fd.get("refund"), notify: !!fd.get("notify"), note: str(fd, "note") || "Anulowane w aplikacji magazynowej",
      });
    } catch (e) {
      await db.from("orders").update({ cancelled_at: null }).eq("id", order.id);
      return { error: errorMessage(e) };
    }
  }

  if (fd.get("cancel_labels")) {
    const { data: ships } = await db.from("shipments").select("id, external_id, state").eq("order_id", order.id);
    const open = (ships ?? []).filter((s) => /^(waiting|ordered|new|created)$/i.test(s.state ?? ""));
    if (open.length) {
      try {
        await cancelPackages(db, open.map((s) => s.external_id));
        await db.from("shipments").update({ state: "canceled", state_description: "Anulowana", updated_at: new Date().toISOString() }).in("id", open.map((s) => s.id));
      } catch (e) {
        notes.push(`Etykieta: ${errorMessage(e)} – anuluj ją w panelu Furgonetki.`);
      }
    }
  }

  const { data: sales } = await db.from("sales").select("id").eq("order_id", order.id);
  await releaseSales((sales ?? []).map((s) => s.id), str(fd, "units") !== "check", notes);

  await db.from("orders").update({ cancelled_at: new Date().toISOString(), status: "cancelled", status_detail: null, status_changed_at: new Date().toISOString() }).eq("id", order.id);
  if (order.store?.shopify_domain) {
    // Zwrot pieniędzy przy anulowaniu (stan „zwrot w toku” / „zwrócone”) od razu na liście.
    const fresh = await getOrder(order.store.shopify_domain, order.store.code, order.shopify_order_id).catch(() => null);
    if (fresh) await saveShopifyOrders(db, order.store_id, [fresh]).catch(() => null);
  }
  revalidatePath(`/sprzedaz/${order.id}`);
  revalidatePath("/sprzedaz");
  return { ok: "Zamówienie anulowane.", notes };
}

/**
 * Zwrot (częściowy): wybrane pozycje i/lub koszt wysyłki i/lub własna kwota – pieniądze w Shopify;
 * towar wraca na stan, do sprawdzenia albo zostaje u klienta (sam zwrot pieniędzy).
 */
export async function returnOrderAction(_: OrderOpState, fd: FormData): Promise<OrderOpState> {
  let supabase;
  try {
    ({ supabase } = await requireAdmin());
  } catch (e) {
    return { error: errorMessage(e) };
  }
  const order = await loadOrder(str(fd, "order_id"));
  if (!order) return { error: "Nie ma takiego zamówienia." };
  const picked = order.line_items
    .map((l) => ({ line: l, qty: Math.min(l.quantity, Math.max(0, Math.floor(num(fd, `qty_${l.id}`)))) }))
    .filter((x) => x.qty > 0);
  const refundMoney = !!fd.get("refund");
  const rawAmount = str(fd, "amount").replace(/\s/g, "").replace(",", ".");
  const amount = rawAmount ? Math.round(Number(rawAmount) * 100) / 100 : null;
  if (amount !== null && !(amount > 0)) return { error: "Kwota zwrotu musi być większa od zera." };
  const shipping = !!fd.get("shipping");
  if (!picked.length && !shipping && !(refundMoney && amount)) return { error: "Wybierz pozycje, koszt wysyłki albo wpisz kwotę zwrotu." };
  const goods = str(fd, "units"); // stock | check | keep
  if (goods === "keep" && !refundMoney) return { error: "Towar zostaje u klienta – zaznacz zwrot pieniędzy (inaczej nie ma czego zapisać)." };
  const notes: string[] = [];
  let summary = "";

  if (order.store?.shopify_domain) {
    try {
      const r = await refundShopifyLines(order.store.shopify_domain, order.store.code, order.shopify_order_id,
        picked.map((p) => ({ lineItemId: p.line.id, quantity: p.qty })),
        { refundMoney, shipping, notify: !!fd.get("notify"), note: str(fd, "note") || undefined, amount, keepGoods: goods === "keep", key: /^[0-9a-f-]{36}$/i.test(str(fd, "nonce")) ? `zwrot-${str(fd, "nonce")}` : undefined });
      summary = r.moneyBack ? ` Zwrot pieniędzy: ${(amount ?? r.suggested).toFixed(2)} zł.` : refundMoney ? " Shopify nie zwrócił pieniędzy automatycznie (np. płatność za pobraniem) – oddaj je ręcznie." : "";
    } catch (e) {
      return { error: errorMessage(e) };
    }
  }

  if (goods !== "keep" && picked.length) {
    // Pozycje Shopify → linie sprzedaży tej pozycji (albo z Base z tym samym rozmiarem) w tym zamówieniu.
    const { data: sales } = await supabase.from("sales").select("id, variant_id, status, shopify_line_id, shopify_line_index").eq("order_id", order.id);
    const variantIds = await Promise.all(picked.map(async (p) => {
      if (!p.line.shopify_variant_id) return null;
      const { data } = await supabase.from("variant_store_links").select("variant_id").eq("shopify_variant_id", p.line.shopify_variant_id).limit(1).maybeSingle();
      return (data?.variant_id as string | undefined) ?? null;
    }));
    const used = new Set<string>();
    const saleIds: string[] = [];
    picked.forEach((p, i) => {
      const free = (sales ?? []).filter((s) => !used.has(s.id) && s.status !== "cancelled");
      const pool = [
        ...free.filter((s) => s.shopify_line_id === p.line.id),
        ...free.filter((s) => !s.shopify_line_id && variantIds[i] && s.variant_id === variantIds[i]),
      ];
      for (const s of pool.slice(0, p.qty)) {
        used.add(s.id);
        saleIds.push(s.id);
      }
      if (pool.length < p.qty) notes.push(`${p.line.title} ${p.line.variant_title ?? ""}: nie znalazłem sztuki w magazynie – sprawdź ręcznie.`);
    });
    await releaseSales(saleIds, goods !== "check", notes);
  }

  if (order.store?.shopify_domain) {
    // Odświeżenie po zwrocie nie może zgłosić błędu – zwrot już się wykonał (ponowne wysłanie zwróciłoby drugi raz).
    const fresh = await getOrder(order.store.shopify_domain, order.store.code, order.shopify_order_id).catch(() => null);
    if (fresh) await saveShopifyOrders(createAdminClient(), order.store_id, [fresh]).catch((e) => notes.push(`Odświeżenie zamówienia: ${errorMessage(e)}`));
  }
  revalidatePath(`/sprzedaz/${order.id}`);
  revalidatePath("/sprzedaz");
  return { ok: `Zwrot zapisany.${summary}`, notes };
}

export type ReceiptState = { ok?: string; error?: string } | null;

/** „Drukuj paragon”: paragon w Base do zamówienia (raz), wydruk na drukarce fiskalnej podpiętej do Base. */
export async function issueReceipt(_: ReceiptState, fd: FormData): Promise<ReceiptState> {
  const { profile } = await requireProfile();
  const db = createAdminClient();
  const orderId = str(fd, "order_id");
  const { data: order } = await db.from("orders").select("id, name, cancelled_at, receipt_id").eq("id", orderId).maybeSingle();
  if (!order) return { error: "Nie ma takiego zamówienia." };
  if (order.receipt_id) return { ok: `Paragon już wystawiony (nr ${order.receipt_id}).` };
  if (order.cancelled_at) return { error: "Zamówienie jest anulowane." };
  const { data: sale } = await db.from("sales").select("base_order_id").eq("order_id", order.id).limit(1).maybeSingle();
  if (!sale?.base_order_id) return { error: "Nie znalazłem tego zamówienia w Base – poczekaj na odczyt zamówień (co 5 minut) i spróbuj ponownie." };
  // Blokada przed podwójnym kliknięciem: rezerwujemy wystawienie przed wywołaniem Base.
  const { data: locked } = await db.from("orders").update({ receipt_at: new Date().toISOString(), receipt_by: profile.id })
    .eq("id", order.id).is("receipt_id", null).or(`receipt_at.is.null,receipt_at.lt.${new Date(Date.now() - 60_000).toISOString()}`).select("id");
  if (!locked?.length) return { error: "Paragon jest właśnie wystawiany – odśwież stronę za chwilę." };
  try {
    const receiptId = await addReceipt(Number(sale.base_order_id));
    await db.from("orders").update({ receipt_id: receiptId }).eq("id", order.id);
    revalidatePath(`/sprzedaz/${order.id}`);
    revalidatePath("/sprzedaz");
    return { ok: `Paragon wysłany do drukarki (nr ${receiptId}).` };
  } catch (e) {
    await db.from("orders").update({ receipt_at: null, receipt_by: null }).eq("id", order.id).is("receipt_id", null);
    return { error: errorMessage(e) };
  }
}
