"use server";

import { can } from "@/lib/permissions";

import { manualPayment } from "@/lib/orders/payment";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin, requireSection } from "@/lib/auth";
import { errorMessage } from "@/lib/errors";
import { adjustStock, type StockChange } from "@/lib/stock";
import type { LineItem } from "@/lib/sync/shop-orders";
import { createAdminClient } from "@/lib/supabase/admin";
import { accountServices, calculatePrices, cancelPackages, createPackage, deletePackage, furgonetkaConnection, getPackage, orderPackages, type Address, type NewPackage } from "@/lib/integrations/furgonetka";
import { isShopifyOrder } from "@/lib/orders/par-order";
import { cancelShopifyOrder, fulfillWithTracking, getOrder, markPickedUp, markReadyForPickup, refundShopifyLines, type CancelReason } from "@/lib/integrations/shopify";
import { carrierOf, getSender, lockerOnly, LOCKER_SIZES, SERVICE_LABEL, toPoint, type ServiceKey } from "@/lib/orders/sender";
import { clearTrackingPush, pushPendingTracking, queueTrackingPush, refreshOrderStatus, saveShopifyOrders, syncFurgonetkaShipments } from "@/lib/sync/shop-orders";

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

/**
 * Dane przesyłki z formularza etykiety. Nadanie zawsze w punkcie: InPost – paczkomat (any_apm albo kod z Ustawień),
 * DPD – punkt DPD Pickup (any_parcel_shop albo kod). Doręczenie: adres, paczkomat InPost, punkt albo paczkomat DPD.
 */
async function buildPackage(db: ReturnType<typeof createAdminClient>, fd: FormData, service: ServiceKey, reference: string, forQuote = false) {
  const carrier = carrierOf(service);
  const point = toPoint(service);
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
  const code = str(fd, "point").toUpperCase();
  if (!forQuote) {
    if (!receiver.name) return { error: "Podaj odbiorcę." };
    if (!receiver.phone) return { error: "Podaj telefon odbiorcy." };
  }
  if (point) {
    if (!code) return { error: service === "inpost_locker" ? "Podaj kod paczkomatu (np. WAW253M)." : "Podaj kod punktu / paczkomatu DPD (np. PL11033)." };
    if (!forQuote && !receiver.email) return { error: "Do punktu i paczkomatu potrzebny jest e-mail odbiorcy." };
    receiver.point = code;
  } else if (!receiver.street || !receiver.postcode || !receiver.city) {
    return { error: "Podaj pełny adres odbiorcy." };
  }

  const weight = num(fd, "weight") || 1;
  const size = str(fd, "size");
  const preset = size in LOCKER_SIZES ? LOCKER_SIZES[size as keyof typeof LOCKER_SIZES] : undefined;
  if (lockerOnly(service) && !preset) return { error: "Wybierz wielkość: Skrytka A, B albo C." };
  if (!preset && size !== "custom") return { error: "Wybierz wielkość paczki." };
  if (preset && weight > preset.maxKg) return { error: `${preset.label}: waga do ${preset.maxKg} kg.` };
  const dims = preset
    ? { width: preset.width, depth: preset.depth, height: preset.height }
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
    point: carrier === "inpost" ? sender.inpost_send_point || "any_apm" : sender.dpd_send_point || "any_parcel_shop",
  };
  const body: Omit<NewPackage, "service_id"> & { service_id?: number } = {
    pickup,
    receiver,
    type: "package",
    // Furgonetka przyjmuje w numerze referencyjnym tylko litery, cyfry i myślniki.
    user_reference_number: reference.replace(/[^\p{L}\p{N}-]/gu, "").slice(0, 30),
    parcels: [{ width: dims.width, depth: dims.depth, height: dims.height, weight, ...(value > 0 ? { value } : {}), description: str(fd, "description") || undefined }],
    additional_services: cod > 0
      ? { cod: { amount: cod, express: false, ...(sender.cod_iban ? { iban: sender.cod_iban.replace(/\s/g, ""), name: sender.company } : {}) } }
      : {},
  };
  return { body, carrier };
}

export type QuoteState = { prices: Partial<Record<ServiceKey, { price: number | null; note?: string }>>; error?: string } | null;

/** Ceny przesyłki dla każdej usługi (wycena w Furgonetce, bez tworzenia przesyłki). */
export async function quoteLabel(fd: FormData): Promise<QuoteState> {
  await requireSection("sprzedaz");
  const db = createAdminClient();
  if (!(await furgonetkaConnection(db))) return { prices: {}, error: "Furgonetka nie jest połączona." };
  const keys = Object.keys(SERVICE_LABEL) as ServiceKey[];
  const prices: NonNullable<QuoteState>["prices"] = {};
  await Promise.all(keys.map(async (k) => {
    const built = await buildPackage(db, fd, k, "WYCENA", true);
    if ("error" in built) { prices[k] = { price: null, note: built.error }; return; }
    try {
      const q = (await calculatePrices(db, [built.carrier], built.body)).find((x) => x.service === built.carrier) ?? null;
      prices[k] = q?.available && q.price !== null ? { price: q.price } : { price: null, note: q?.errors[0] ?? "niedostępne" };
    } catch (e) {
      prices[k] = { price: null, note: errorMessage(e) };
    }
  }));
  return { prices };
}

/** Etykieta z poziomu zamówienia: przesyłka w Furgonetce (InPost / DPD), nadanie, numer do Shopify. */
export async function createLabel(_: LabelState, fd: FormData): Promise<LabelState> {
  const { profile } = await requireSection("sprzedaz");
  const db = createAdminClient();
  const orderId = str(fd, "order_id");
  const { data: order } = await db.from("orders").select("*, store:stores(code, shopify_domain)").eq("id", orderId).maybeSingle();
  if (!order) return { error: "Nie ma takiego zamówienia." };
  if (order.cancelled_at) return { error: "Zamówienie jest anulowane." };
  if (!(await furgonetkaConnection(db))) return { error: "Aplikacja nie jest połączona z Furgonetką (Ustawienia → Wysyłka)." };

  const service = str(fd, "service") as ServiceKey;
  if (!(service in SERVICE_LABEL)) return { error: "Wybierz przewoźnika." };
  // Częściowa wysyłka: zaznaczone pozycje (pole „line:<ID pozycji>” = sztuk). Wszystkie zaznaczone w całości = całe zamówienie.
  const orderLines = ((order.line_items ?? []) as LineItem[]);
  const picked: Record<string, number> = {};
  const anyPick = fd.has("pack");
  for (const [k, v] of fd.entries()) {
    if (!k.startsWith("line:")) continue;
    const lid = k.slice(5);
    const line = orderLines.find((l) => l.id === lid);
    const q = Math.floor(Number(v) || 0);
    if (line && q > 0) picked[lid] = Math.min(q, Number(line.quantity) || q);
  }
  if (anyPick && !Object.keys(picked).length) return { error: "Zaznacz, co jest w tej paczce." };
  const partialLines = anyPick && orderLines.some((l) => (picked[l.id] ?? 0) < (Number(l.quantity) || 0)) ? picked : null;
  const built = await buildPackage(db, fd, service, String(order.number));
  if ("error" in built) return { error: built.error };
  const { body, carrier } = built;

  let services;
  try {
    services = await accountServices(db);
  } catch (e) {
    return { error: errorMessage(e) };
  }
  const svc = services.find((s) => s.service === carrier);
  if (!svc) return { error: `Na koncie Furgonetki nie ma usługi ${carrier.toUpperCase()}.` };
  (body as NewPackage).service_id = svc.id;

  let packageId: string;
  try {
    const pkg = await createPackage(db, body as NewPackage);
    packageId = String(pkg.package_id);
  } catch (e) {
    return { error: errorMessage(e) };
  }
  let { data: ship, error: insErr } = await db.from("shipments").insert({
    order_id: order.id, provider: "furgonetka", external_id: packageId, service: carrier, reference: order.number,
    created_in_app: true, created_by: profile.id, state: "waiting", ...(partialLines ? { order_lines: partialLines } : {}),
  }).select("id").single();
  // Bez SQL 81 (brak kolumny) – zapis bez listy pozycji; w Shopify i tak tylko zaznaczone (poniżej).
  if (insErr && partialLines && /order_lines/.test(insErr.message)) ({ data: ship, error: insErr } = await db.from("shipments").insert({
    order_id: order.id, provider: "furgonetka", external_id: packageId, service: carrier, reference: order.number,
    created_in_app: true, created_by: profile.id, state: "waiting",
  }).select("id").single());
  if (insErr || !ship) return { error: insErr?.message ?? "Nie udało się zapisać przesyłki." };
  // Numer do Shopify: od razu w kolejce (ponawianie co minutę) – nawet gdy dalsza część (nadanie, numer, Shopify)
  // się przerwie (np. limit czasu serwera), zamówienie w Shopify dostanie numer automatycznie.
  const store0 = order.store as { code: string; shopify_domain: string | null } | null;
  const wantFulfill = !!fd.get("fulfill") && !!store0?.shopify_domain && isShopifyOrder(order.shopify_order_id);
  if (wantFulfill) await queueTrackingPush(db, ship.id, !!fd.get("notify"), "nowa etykieta");
  // „Oznacz w Shopify jako wysłane” odznaczone – automat nie dosyła numeru sam.
  else await db.from("sync_state").upsert({ key: `ship_checked:${ship.id}`, value: { at: new Date().toISOString(), skip: true }, updated_at: new Date().toISOString() });

  let processing = false;
  try {
    processing = !(await orderPackages(db, [packageId]));
  } catch (e) {
    await deletePackage(db, packageId).catch(() => {});
    await db.from("shipments").delete().eq("id", ship.id);
    return { error: errorMessage(e) };
  }

  let tracking: string | null = null;
  let trackingUrl: string | null = null;
  // Numer przesyłki bywa nadawany z opóźnieniem – kilka prób (wcześniej brak numeru = cicho bez wysyłki do Shopify).
  for (let attempt = 0; attempt < 3 && !tracking; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 2000));
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
  }

  let warning: string | undefined = processing ? "Furgonetka jeszcze nadaje przesyłkę – etykieta i numer pojawią się za chwilę (odśwież stronę)." : undefined;
  const store = order.store as { code: string; shopify_domain: string | null } | null;
  if (fd.get("fulfill") && store?.shopify_domain && isShopifyOrder(order.shopify_order_id)) {
    const later = "Numer trafi do Shopify automatycznie w ciągu kilku minut (aplikacja ponawia co minutę).";
    if (!tracking) {
      warning = [warning, `Furgonetka nie podała jeszcze numeru przesyłki. ${later}`].filter(Boolean).join(" ");
    } else {
      try {
        const note = await fulfillWithTracking(store.shopify_domain, store.code, order.shopify_order_id, {
          number: tracking, url: trackingUrl, company: carrier === "dpd" ? "DPD" : "InPost",
        }, !!fd.get("notify"), partialLines);
        // Już oznaczone jako wysłane (np. ręcznie, bez numeru) – numer dopisze ponowienie (zostaje w kolejce).
        if (note) warning = `Shopify: ${note}. ${later}`;
        else await clearTrackingPush(db, ship.id);
        const fresh = await getOrder(store.shopify_domain, store.code, order.shopify_order_id);
        if (fresh) await saveShopifyOrders(db, order.store_id, [fresh]);
      } catch (e) {
        warning = `Etykieta jest, ale Shopify nie przyjął numeru: ${errorMessage(e)}. ${later}`;
      }
    }
  }
  await refreshOrderStatus(db, [order.id]);
  revalidatePath(`/sprzedaz/${order.id}`);
  revalidatePath("/sprzedaz");
  return { ok: partialLines ? "Etykieta utworzona (część zamówienia)." : "Etykieta utworzona.", shipmentId: ship.id, tracking: tracking ?? undefined, warning };
}

/** Odświeżenie jednego zamówienia ze Shopify i stanów przesyłek. */
export async function refreshOrder(fd: FormData) {
  await requireSection("sprzedaz");
  const db = createAdminClient();
  const id = str(fd, "id");
  const { data: order } = await db.from("orders").select("id, store_id, shopify_order_id, store:stores(code, shopify_domain)").eq("id", id).maybeSingle();
  if (!order) return;
  const store = order.store as unknown as { code: string; shopify_domain: string | null } | null;
  if (store?.shopify_domain && isShopifyOrder(order.shopify_order_id)) {
    const fresh = await getOrder(store.shopify_domain, store.code, order.shopify_order_id);
    if (fresh) await saveShopifyOrders(db, order.store_id, [fresh]);
  }
  if (await furgonetkaConnection(db)) {
    await syncFurgonetkaShipments(db, 1).catch(() => null);
    // Zaległy numer przesyłki do Shopify – od razu przy odświeżeniu, bez czekania na automat.
    await pushPendingTracking(db).catch(() => null);
  }
  await db.rpc("link_sales_to_orders");
  await refreshOrderStatus(db, [id]);
  revalidatePath(`/sprzedaz/${id}`);
}

export type OrderOpState = { error?: string; ok?: string; notes?: string[] } | null;

type OrderForOp = {
  id: string; store_id: string; shopify_order_id: string; name: string; cancelled_at: string | null; line_items: LineItem[];
  cod: boolean | null; payment_gateways: string[] | null; customer_name: string | null; email: string | null; total: number | null;
  store: { code: string; shopify_domain: string | null } | null;
};

async function loadOrder(id: string) {
  const db = createAdminClient();
  const { data } = await db.from("orders").select("id, store_id, shopify_order_id, name, cancelled_at, line_items, refunded_lines, cod, payment_gateways, customer_name, email, total, store:stores(code, shopify_domain)").eq("id", id).maybeSingle();
  return data as unknown as OrderForOp | null;
}

/**
 * Sztuki z linii sprzedaży wracają na stan (+1 w Shopify) albo „do sprawdzenia”.
 * Linie bez sprzedanej sztuki (brak sztuki, towar w drodze) są anulowane.
 */
async function releaseSales(saleIds: string[], backToStock: boolean, notes: string[]) {
  const { supabase } = await requireSection("sprzedaz");
  if (!saleIds.length) return;
  const { data: sales } = await supabase.from("sales").select("id, status, unit:units(id, code, status, variant_id, location_id)").in("id", saleIds);
  const changes: StockChange[] = [];
  for (const s of sales ?? []) {
    // Sprzedaż już anulowana: sztuka mogła pójść do innego zamówienia – nie wolno jej „zwracać”.
    if (s.status === "cancelled") continue;
    const u = s.unit as unknown as { id: string; code: string; status: string; variant_id: string; location_id: string } | null;
    // Także „zarezerwowana” (zamówienie bez paragonu): Shopify przy anulowaniu / zwrocie w aplikacji nie przywraca stanu.
    if (u && ["sold", "shipped", "reserved"].includes(u.status)) {
      const { error } = await supabase.rpc("return_unit", { p_unit_id: u.id, p_back_to_stock: backToStock });
      if (error) notes.push(`${u.code}: ${error.message}`);
      else if (backToStock) changes.push({ variantId: u.variant_id, locationId: u.location_id, delta: 1 });
    } else if (s.status !== "cancelled") {
      await supabase.from("sales").update({ status: "cancelled" }).eq("id", s.id);
    }
  }
  if (changes.length) {
    for (const r of await adjustStock(supabase, changes)) if (!r.ok) notes.push(`Stan w Shopify: ${r.message}`);
  }
}

/** Przypomnienie w „Do zrobienia”: zwrot pieniędzy, którego Shopify nie zrobi (pobranie / zwykły przelew). */
async function manualRefundTask(order: OrderForOp, kind: string, amount: number | null) {
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });
  const kwota = amount !== null ? `${amount.toFixed(2).replace(".", ",")} zł` : "pieniądze";
  const { error } = await createAdminClient().from("tasks").insert({
    title: `Przelej zwrot ${kwota} – zamówienie ${order.name}`,
    notes: [`Zamówienie ${order.name} było opłacone ${kind} – Shopify nie odeśle pieniędzy sam. Zrób przelew i odhacz zadanie.`,
      order.customer_name ? `Klient: ${order.customer_name}` : "", order.email ? `E-mail: ${order.email}` : ""].filter(Boolean).join("\n"),
    priority: "high", due_date: today, start_date: today, assignees: [],
  });
  return error ? `Nie udało się dodać przypomnienia: ${error.message}` : `Dodane przypomnienie w „Do zrobienia”: przelej ${kwota} klientowi.`;
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

  if (order.store?.shopify_domain && isShopifyOrder(order.shopify_order_id)) {
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
        const confirmed = await cancelPackages(db, open.map((s) => s.external_id));
        if (!confirmed) notes.push("Etykieta: Furgonetka jeszcze przetwarza anulowanie – sprawdź za chwilę w panelu Furgonetki, czy przesyłka jest anulowana.");
        else await db.from("shipments").update({ state: "canceled", state_description: "Anulowana", updated_at: new Date().toISOString() }).in("id", open.map((s) => s.id));
      } catch (e) {
        notes.push(`Etykieta: ${errorMessage(e)} – anuluj ją w panelu Furgonetki.`);
      }
    }
  }

  const manualKind = manualPayment(order);
  if (fd.get("refund") && manualKind) notes.push(`Zamówienie opłacone ${manualKind} – Shopify nie zwróci pieniędzy. ${await manualRefundTask(order, manualKind, order.total !== null ? Number(order.total) : null)}`);

  const { data: sales } = await db.from("sales").select("id").eq("order_id", order.id);
  await releaseSales((sales ?? []).map((s) => s.id), str(fd, "units") !== "check", notes);

  await db.from("orders").update({ cancelled_at: new Date().toISOString(), status: "cancelled", status_detail: null, status_changed_at: new Date().toISOString() }).eq("id", order.id);
  if (order.store?.shopify_domain && isShopifyOrder(order.shopify_order_id)) {
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
    // Nie więcej niż zostało (pozycje już zwrócone wcześniej się nie liczą).
    .map((l) => ({ line: l, qty: Math.min(l.quantity - Number((order as { refunded_lines?: Record<string, number> | null }).refunded_lines?.[l.id] ?? 0), Math.max(0, Math.floor(num(fd, `qty_${l.id}`)))) }))
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

  if (order.store?.shopify_domain && isShopifyOrder(order.shopify_order_id)) {
    try {
      const r = await refundShopifyLines(order.store.shopify_domain, order.store.code, order.shopify_order_id,
        picked.map((p) => ({ lineItemId: p.line.id, quantity: p.qty })),
        { refundMoney, shipping, notify: !!fd.get("notify"), note: str(fd, "note") || undefined, amount, keepGoods: goods === "keep", key: /^[0-9a-f-]{36}$/i.test(str(fd, "nonce")) ? `zwrot-${str(fd, "nonce")}` : undefined });
      const manualKind = manualPayment(order);
      summary = r.moneyBack && !manualKind ? ` Zwrot pieniędzy: ${(amount ?? r.suggested).toFixed(2)} zł.` : "";
      if (refundMoney && (!r.moneyBack || manualKind)) {
        const kind = manualKind ?? "płatnością, której Shopify nie zwraca automatycznie";
        notes.push(`Zamówienie opłacone ${kind} – Shopify nie odeśle pieniędzy. ${await manualRefundTask(order, kind, amount ?? r.suggested)}`);
      }
    } catch (e) {
      return { error: errorMessage(e) };
    }
  }

  if (goods !== "keep" && picked.length) {
    // Pozycje Shopify → linie sprzedaży tej pozycji (albo z tym samym rozmiarem) w tym zamówieniu.
    const { data: sales } = await supabase.from("sales").select("id, variant_id, status, shopify_line_id, shopify_line_index").eq("order_id", order.id);
    const variantIds = await Promise.all(picked.map(async (p) => {
      if (!p.line.shopify_variant_id) return null;
      const { data } = await supabase.from("variant_store_links").select("variant_id").eq("shopify_variant_id", p.line.shopify_variant_id).limit(1).maybeSingle();
      return (data?.variant_id as string | undefined) ?? null;
    }));
    const used = new Set<string>();
    const saleIds: string[] = [];
    picked.forEach((p, i) => {
      // Pozycja spoza magazynu (np. sznurówki rope) – bez sztuki do zwrotu na stan.
      if (p.line.service) return;
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

  if (order.store?.shopify_domain && isShopifyOrder(order.shopify_order_id)) {
    // Odświeżenie po zwrocie nie może zgłosić błędu – zwrot już się wykonał (ponowne wysłanie zwróciłoby drugi raz).
    const fresh = await getOrder(order.store.shopify_domain, order.store.code, order.shopify_order_id).catch(() => null);
    if (fresh) await saveShopifyOrders(createAdminClient(), order.store_id, [fresh]).catch((e) => notes.push(`Odświeżenie zamówienia: ${errorMessage(e)}`));
  }
  revalidatePath(`/sprzedaz/${order.id}`);
  revalidatePath("/sprzedaz");
  return { ok: `Zwrot zapisany.${summary}`, notes };
}


/** Odbiór osobisty: „Gotowe do odbioru” (Shopify wysyła e-mail klientowi) albo „Klient odebrał”. */
export async function pickupAction(_: OrderOpState, fd: FormData): Promise<OrderOpState> {
  await requireSection("sprzedaz");
  const db = createAdminClient();
  const order = await loadOrder(str(fd, "id"));
  if (!order) return { error: "Nie ma takiego zamówienia." };
  if (!order.store?.shopify_domain || !isShopifyOrder(order.shopify_order_id)) return { error: "To zamówienie nie jest ze Shopify." };
  const step = str(fd, "step");
  try {
    const note = step === "picked"
      ? await markPickedUp(order.store.shopify_domain, order.store.code, order.shopify_order_id)
      : await markReadyForPickup(order.store.shopify_domain, order.store.code, order.shopify_order_id);
    if (note) return { error: note };
    const fresh = await getOrder(order.store.shopify_domain, order.store.code, order.shopify_order_id);
    if (fresh) await saveShopifyOrders(db, order.store_id, [fresh]);
    await refreshOrderStatus(db, [order.id]);
  } catch (e) {
    const m = errorMessage(e);
    return { error: /access|scope|permission|denied/i.test(m) ? `${m} – aplikacja w Shopify potrzebuje uprawnienia „write_merchant_managed_fulfillment_orders” (Dev Dashboard → aplikacja → Konfiguracja → zakresy).` : m };
  }
  revalidatePath(`/sprzedaz/${order.id}`);
  revalidatePath("/sprzedaz");
  return { ok: step === "picked" ? "Zamówienie oznaczone jako odebrane." : "Gotowe do odbioru – Shopify wysłał klientowi e-mail." };
}

/**
 * Paragon PDF (PAR, bez paragonu fiskalnego, poza JPK) do zamówienia – tak jak „Drukuj paragon PDF” w Kasie.
 * Pozycje z zamówienia (bez zwróconych), wysyłka 23%.
 */
export async function issueOrderReceiptPdf(fd: FormData) {
  const { profile } = await requireSection("sprzedaz", "faktury");
  const db = createAdminClient();
  const orderId = str(fd, "order_id");
  const back = (m: string) => redirect(`/sprzedaz/${orderId}?blad=${encodeURIComponent(m)}`);
  const { data: order } = await db.from("orders").select("id, receipt_id, cancelled_at").eq("id", orderId).maybeSingle();
  if (!order) return back("Nie ma takiego zamówienia.");
  if (order.cancelled_at) return back("Zamówienie jest anulowane.");
  const { data: had } = await db.from("invoices").select("id, kind, number").eq("order_id", orderId).not("status", "in", "(rejected,cancelled)").limit(5);
  const par = (had ?? []).find((d) => d.kind === "receipt");
  if (par) redirect(`/sprzedaz/faktury/${par.id}`);
  const inv = (had ?? []).find((d) => d.kind !== "receipt");
  if (inv) return back(`Do zamówienia jest już faktura ${inv.number}.`);
  if (order.receipt_id) return back("Do zamówienia jest już paragon fiskalny.");
  const { draftFromOrder, issueReceipt } = await import("@/lib/invoices/service");
  let id: string;
  try {
    const draft = await draftFromOrder(db, orderId);
    if (!draft) throw new Error("Nie ma takiego zamówienia.");
    if (!draft.items.length) throw new Error("Zamówienie nie ma pozycji do paragonu.");
    const row = await issueReceipt(db, { ...draft, orderId, notes: null }, profile.id, { withBuyer: true });
    id = row.id as string;
  } catch (e) {
    return back(`Paragon PDF nie powstał: ${errorMessage(e)}`);
  }
  revalidatePath(`/sprzedaz/${orderId}`);
  redirect(`/sprzedaz/faktury/${id}`);
}

export type TrackingState = { ok?: string; error?: string } | null;

const CARRIERS = ["InPost", "DPD", "DHL", "GLS", "UPS", "FedEx", "Poczta Polska", "Orlen Paczka", "Inny"];

/** Numer przesyłki nadanej poza Furgonetką (np. ręcznie u kuriera): do Shopify (zamówienie wysłane) i do zamówienia w aplikacji. */
export async function addManualTracking(_: TrackingState, fd: FormData): Promise<TrackingState> {
  await requireSection("sprzedaz");
  const db = createAdminClient();
  const orderId = str(fd, "order_id");
  const number = str(fd, "number").replace(/\s+/g, "").slice(0, 60);
  const carrier = CARRIERS.includes(str(fd, "carrier")) ? str(fd, "carrier") : "Inny";
  const urlRaw = str(fd, "url");
  const url = /^https?:\/\/\S+$/i.test(urlRaw) ? urlRaw.slice(0, 500) : null;
  const notify = !!fd.get("notify");
  if (!/^[A-Za-z0-9-]{4,60}$/.test(number)) return { error: "Wpisz numer przesyłki (litery i cyfry)." };
  const { data: order } = await db.from("orders").select("id, store_id, shopify_order_id, cancelled_at, number, store:stores(code, shopify_domain)").eq("id", orderId).maybeSingle();
  if (!order) return { error: "Nie ma takiego zamówienia." };
  if (order.cancelled_at) return { error: "Zamówienie jest anulowane." };
  const store = order.store as unknown as { code: string; shopify_domain: string | null } | null;
  const shopify = !!store?.shopify_domain && isShopifyOrder(order.shopify_order_id);
  // Zamówienie spoza Shopify (wysyłka z paragonu PAR): przesyłka zapisana w aplikacji. Ze Shopify – numer i status
  // przychodzą z realizacji w Shopify (Shopify sam śledzi doręczenie u znanych przewoźników).
  const { error: sErr } = shopify ? { error: null } : await db.from("shipments").upsert({
    order_id: order.id, provider: "manual", external_id: number, service: carrier, tracking_number: number, tracking_url: url,
    state: "shipped", state_description: `Nadana poza Furgonetką (${carrier})`, state_at: new Date().toISOString(), reference: order.number,
    created_in_app: true, updated_at: new Date().toISOString(),
  }, { onConflict: "provider,external_id" });
  if (sErr) return { error: sErr.message };
  let note = "";
  if (shopify && store?.shopify_domain) {
    const t = { number, url, company: carrier === "Inny" ? "Other" : carrier };
    try {
      const open = await fulfillWithTracking(store.shopify_domain, store.code, order.shopify_order_id, t, notify);
      if (open) {
        // Już oznaczone jako wysłane (np. bez numeru) – dopisujemy numer do tej realizacji.
        const { addTrackingToFulfillment } = await import("@/lib/integrations/shopify");
        const added = await addTrackingToFulfillment(store.shopify_domain, store.code, order.shopify_order_id, t, notify);
        note = added ? " Numer dopisany do wysyłki w Shopify." : " W Shopify zamówienie jest już wysłane z innym numerem – numer zapisany tylko w aplikacji.";
      } else note = ` Zamówienie oznaczone w Shopify jako wysłane${notify ? " (klient dostał e-mail z numerem)" : ""}.`;
      const fresh = await getOrder(store.shopify_domain, store.code, order.shopify_order_id);
      if (fresh) await saveShopifyOrders(db, order.store_id, [fresh]);
    } catch (e) {
      return { error: `Shopify nie przyjął numeru: ${errorMessage(e)}` };
    }
  }
  await refreshOrderStatus(db, [order.id]);
  revalidatePath(`/sprzedaz/${order.id}`);
  revalidatePath("/sprzedaz");
  return { ok: `Zapisano przesyłkę ${carrier} ${number}.${note}` };
}

/** Notatka pracowników do zamówienia (czerwona, na górze). Pusta treść – usuwa notatkę. */
export async function saveOrderNote(fd: FormData) {
  const { profile } = await requireSection("sprzedaz");
  const id = str(fd, "order_id");
  const note = fd.get("delete") ? "" : str(fd, "staff_note").slice(0, 2000);
  const { error } = await createAdminClient().from("orders").update(note
    ? { staff_note: note, staff_note_by: profile.full_name ?? profile.email ?? null, staff_note_at: new Date().toISOString() }
    : { staff_note: null, staff_note_by: null, staff_note_at: null }).eq("id", id);
  const msg = error
    ? `blad=${encodeURIComponent(/staff_note/.test(error.message) ? "Notatki do zamówień wymagają SQL 69 w Supabase (0069_order_staff_note.sql)." : error.message)}`
    : `ok=${encodeURIComponent(note ? "Notatka zapisana." : "Notatka usunięta.")}`;
  revalidatePath(`/sprzedaz/${id}`);
  revalidatePath("/sprzedaz");
  redirect(`/sprzedaz/${id}?${msg}`);
}

/** Nazwa / stawka VAT pozycji w tym zamówieniu (paragon, paragon PDF, faktura). Pusta nazwa i „automatycznie” = bez zmian. */
export async function saveLineOverride(fd: FormData) {
  const { profile } = await requireSection("sprzedaz");
  // Stawkę VAT na paragonie / fakturze zmienia tylko administrator albo osoba z działem Faktury i JPK.
  const canVat = can(profile, "faktury");
  const id = str(fd, "order_id");
  const lineId = str(fd, "line_id");
  const db = createAdminClient();
  const { data: o, error: rErr } = await db.from("orders").select("line_overrides").eq("id", id).maybeSingle();
  if (rErr || !o) redirect(`/sprzedaz/${id}?blad=${encodeURIComponent(rErr && /line_overrides/.test(rErr.message) ? "Zmiana nazwy / VAT w zamówieniu wymaga SQL 70 w Supabase (0070_receipt_names_line_overrides.sql)." : "Nie ma takiego zamówienia.")}`);
  const all = { ...((o!.line_overrides ?? {}) as Record<string, { name?: string | null; vat?: string | null }>) };
  const name = fd.get("reset") ? "" : str(fd, "name").slice(0, 120);
  const vatRaw = fd.get("reset") ? "" : str(fd, "vat");
  const prevVat = all[lineId]?.vat ?? null;
  const vat = canVat ? (vatRaw === "23" || vatRaw === "margin" ? vatRaw : null) : prevVat;
  if (!name && !vat) delete all[lineId];
  else all[lineId] = { name: name || null, vat };
  const { error } = await db.from("orders").update({ line_overrides: all }).eq("id", id);
  revalidatePath(`/sprzedaz/${id}`);
  redirect(`/sprzedaz/${id}?${error ? `blad=${encodeURIComponent(error.message)}` : `ok=${encodeURIComponent(!name && !vat ? "Przywrócono nazwę i stawkę z zamówienia." : "Zapisano – nowe paragony i faktury do tego zamówienia użyją tej nazwy / stawki.")}`}`);
}
