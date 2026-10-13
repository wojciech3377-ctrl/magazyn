import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Zamówienie „wysyłka z paragonu PAR”: paragon PDF z Kasy z opcją Wysyłka trafia jako
 * zamówienie do Sprzedaż → Zamówienia (etykieta, statusy), ale nie wchodzi do JPK. Umowy jego sztuk są odpinane –
 * wracają do „Umowy bez rzeczy” (niewykorzystane) i można je użyć przy innej sprzedaży.
 */

export const PAR_PREFIX = "par:";

/** Zamówienie ze Shopify (a nie utworzone z paragonu PAR w aplikacji). */
export const isShopifyOrder = (shopifyOrderId: string | null | undefined) => !!shopifyOrderId && !shopifyOrderId.startsWith(PAR_PREFIX);
export const isParOrder = (shopifyOrderId: string | null | undefined) => !!shopifyOrderId && shopifyOrderId.startsWith(PAR_PREFIX);

export type ParShipping = {
  storeId: string;
  name: string;
  phone: string;
  email: string | null;
  street: string;
  zip: string;
  city: string;
  country: string;
  method: string;
  point: string | null;
  note: string | null;
};

/** Dane wysyłki z formularza (pola ship_*; opcja „Wysyłka” w Kasie). null = bez wysyłki. */
export function readParShipping(fd: FormData): ParShipping | { error: string } | null {
  if (fd.get("ship") !== "1") return null;
  const v = (k: string) => String(fd.get(`ship_${k}`) ?? "").trim().slice(0, 200);
  const ship: ParShipping = {
    storeId: v("store"), name: v("name"), phone: v("phone"), email: v("email") || null, street: v("street"), zip: v("zip"), city: v("city"),
    country: (v("country") || "PL").toUpperCase().slice(0, 2), method: v("method") || "Kurier", point: v("point") || null, note: v("note") || null,
  };
  if (!/^[0-9a-f-]{36}$/.test(ship.storeId)) return { error: "Wybierz sklep, z którego idzie wysyłka." };
  if (!ship.name || !ship.phone) return { error: "Wysyłka: podaj odbiorcę i telefon." };
  const locker = /paczkomat/i.test(ship.method);
  if (locker && !ship.point) return { error: "Wysyłka do paczkomatu: podaj kod paczkomatu (np. WAW123M)." };
  if (!locker && (!ship.street || !ship.zip || !ship.city)) return { error: "Wysyłka kurierem: podaj ulicę, kod pocztowy i miasto." };
  if (ship.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ship.email)) return { error: "Wysyłka: nieprawidłowy e-mail." };
  return ship;
}

type Item = { name: string; quantity: number; unit_price_gross: number; unit_id?: string | null };

export async function createParShippingOrder(
  db: SupabaseClient,
  p: { receiptId: string; number: string; payment: string; items: Item[]; ship: ParShipping },
) {
  const unitIds = [...new Set(p.items.map((i) => i.unit_id).filter((x): x is string => !!x))];
  const { data: units } = unitIds.length
    ? await db.from("units").select("id, code, contract_id, variant_id, variant:variants(option, product:products(title, image_url))").in("id", unitIds)
    : { data: [] };
  type U = { id: string; code: string; contract_id: string | null; variant_id: string; variant: { option: string; product: { title: string; image_url: string | null } } | null };
  const unitOf = new Map(((units ?? []) as unknown as U[]).map((u) => [u.id, u]));

  const lineItems = p.items.map((i, k) => {
    const u = i.unit_id ? unitOf.get(i.unit_id) : undefined;
    return {
      id: `par-${k}`,
      title: u?.variant?.product.title ?? i.name,
      variant_title: u?.variant?.option ?? null,
      sku: u?.code ?? null,
      quantity: i.quantity,
      image: u?.variant?.product.image_url ?? null,
      shopify_variant_id: null,
      price: i.unit_price_gross,
      service: false,
    };
  });
  const total = Math.round(p.items.reduce((s, i) => s + i.unit_price_gross * i.quantity, 0) * 100) / 100;
  const s = p.ship;
  const { data: order, error } = await db.from("orders").insert({
    store_id: s.storeId,
    shopify_order_id: `${PAR_PREFIX}${p.receiptId}`,
    name: p.number,
    number: p.number,
    ordered_at: new Date().toISOString(),
    customer_name: s.name,
    email: s.email,
    phone: s.phone,
    shipping_address: { name: s.name, address1: s.street, address2: null, zip: s.zip, city: s.city, countryCodeV2: s.country, phone: s.phone },
    shipping_method: s.method,
    pickup_point: s.point,
    payment_gateways: [p.payment],
    financial_status: "PAID",
    cod: false,
    total,
    outstanding: 0,
    currency: "PLN",
    note: [`Wysyłka z paragonu ${p.number} – poza JPK`, s.note].filter(Boolean).join(" · "),
    line_items: lineItems,
    status: "new",
    status_detail: "wysyłka z paragonu PAR",
  }).select("id").single();
  if (error) throw error;

  // Dokument przy zamówieniu (podgląd paragonu w zamówieniu).
  await db.from("invoices").update({ order_id: order.id }).eq("id", p.receiptId);

  // Sztuki z paragonu jako linie sprzedaży zamówienia (kody przy zamówieniu, etykieta).
  const sales = p.items.map((i, k) => ({ i, k })).filter(({ i }) => i.unit_id && unitOf.has(i.unit_id)).map(({ i, k }) => {
    const u = unitOf.get(i.unit_id!)!;
    return {
      store_id: s.storeId, order_id: order.id, unit_id: u.id, variant_id: u.variant_id, status: "assigned",
      order_ref: p.number, product_name: lineItems[k].title, price: i.unit_price_gross, sold_at: new Date().toISOString(), shopify_line_index: k,
    };
  });
  if (sales.length) await db.from("sales").insert(sales);

  // Umowy sztuk wracają do niewykorzystanych (sprzedaż poza JPK nie zużywa umowy).
  const withContract = [...unitOf.values()].filter((u) => u.contract_id);
  if (withContract.length) {
    await db.from("units").update({ contract_id: null }).in("id", withContract.map((u) => u.id));
    await db.from("unit_events").insert(withContract.map((u) => ({
      unit_id: u.id, type: "contract", data: { detached: u.contract_id, note: `wysyłka z paragonu ${p.number} (poza JPK) – umowa wraca do niewykorzystanych` },
    })));
  }
  return { orderId: order.id as string, freedContracts: withContract.length };
}
