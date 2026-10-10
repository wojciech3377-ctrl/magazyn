/** Statusy zamówień i rozpoznawanie wysyłki / płatności. Bez zależności serwerowych (UI + synchronizacja). */

export type OrderStatus = "new" | "shipped" | "delivered" | "problem" | "cancelled" | "returned";

export const ORDER_STATUS: Record<OrderStatus, string> = {
  new: "Nowe",
  shipped: "Wysłane",
  delivered: "Dostarczone",
  problem: "Problem",
  cancelled: "Anulowane",
  returned: "Zwrócone",
};

export const ORDER_STATUS_TONE: Record<OrderStatus, "slate" | "red" | "amber" | "green" | "blue"> = {
  new: "amber",
  shipped: "blue",
  delivered: "green",
  problem: "red",
  cancelled: "slate",
  returned: "slate",
};

export type Fulfillment = {
  status: string;
  displayStatus: string | null;
  createdAt: string;
  trackingInfo: { number: string | null; company: string | null; url: string | null }[];
};

export type ShipmentLike = { state: string | null; state_description: string | null; state_at: string | null; tracking_number: string | null };

const PROBLEM_STATE = /return|lost|damag|refus|undeliver|not_deliver|fail|problem|aviso|avizo|error|hold|stopp?ed/i;
const PROBLEM_TEXT = /zwrot|nieudan|odmow|zagubi|uszkodz|niedor[eę]cz|nie dor[eę]cz|awiz|problem|nie odebra|b[łl][eę]dn|wstrzyma|nieobecn|brak odbiorcy|returned|undeliver|failed|refused|damaged|lost/i;

/** Stan przesyłki z Furgonetki → etap zamówienia. null = przesyłka anulowana (nie liczy się). */
export function classifyShipment(s: Pick<ShipmentLike, "state" | "state_description">): "shipped" | "delivered" | "problem" | null {
  const state = (s.state ?? "").toLowerCase();
  const text = s.state_description ?? "";
  if (/^cancel+ed$|^canceled$/.test(state) || /^anulowan/i.test(text)) return null;
  if (PROBLEM_STATE.test(state) || PROBLEM_TEXT.test(text)) return "problem";
  if (/deliver(ed)?$|picked_?up|received/.test(state) || /dor[eę]czon|odebran[ao]|delivered/i.test(text)) return "delivered";
  return "shipped";
}

const PICKUP = /odbi[oó]r osobist|personal pickup|local pickup|pickup in store|sneakers depot poznań|w sklepie/i;

export function isPersonalPickup(method: string | null | undefined) {
  return !!method && PICKUP.test(method);
}

/** Zwroty pieniędzy i towaru zapisane przy zamówieniu (ze Shopify). */
export type RefundFields = {
  financial_status?: string | null;
  return_status?: string | null;
  refunded_amount?: number | string | null;
  refund_pending?: number | string | null;
  refunded_lines?: Record<string, number> | null;
  line_items?: { id: string; quantity: number; service?: boolean }[] | null;
  total?: number | string | null;
};

/** Stan zwrotu pieniędzy: brak / w toku / częściowy / całość. */
export function refundState(o: RefundFields): { money: "none" | "pending" | "partial" | "full"; allItems: boolean; refunded: number; pending: number } {
  const fs = (o.financial_status ?? "").toUpperCase();
  const refunded = Number(o.refunded_amount ?? 0) || 0;
  const pending = Number(o.refund_pending ?? 0) || 0;
  const total = Number(o.total ?? 0) || 0;
  const goods = (o.line_items ?? []).filter((l) => !l.service);
  const qty = goods.reduce((s, l) => s + l.quantity, 0);
  const back = goods.reduce((s, l) => s + Math.min(l.quantity, o.refunded_lines?.[l.id] ?? 0), 0);
  const allItems = qty > 0 && back >= qty;
  const money = pending > 0 ? "pending"
    : fs === "REFUNDED" || (total > 0 && refunded >= total - 0.01) ? "full"
    : refunded > 0 || fs === "PARTIALLY_REFUNDED" ? "partial" : "none";
  return { money, allItems, refunded, pending };
}

export type OrderForStatus = RefundFields & { cancelled_at: string | null; closed_at?: string | null; fulfillments: Fulfillment[]; shipping_method: string | null };

/** Etap zamówienia z anulowania, zwrotów, przesyłek Furgonetki i realizacji w Shopify. */
export function computeOrderStatus(o: OrderForStatus, shipments: ShipmentLike[]): { status: OrderStatus; detail: string | null } {
  if (o.cancelled_at) return { status: "cancelled", detail: null };
  const r = refundState(o);
  const ret = (o.return_status ?? "").toUpperCase();
  const total = Number(o.total ?? 0) || 0;
  const wholeMoney = r.money === "full" || (total > 0 && r.refunded + r.pending >= total - 0.01);
  if (ret === "RETURNED" || ret === "INSPECTION_COMPLETE" || r.allItems || wholeMoney) {
    const detail = r.pending > 0 ? "zwrot pieniędzy w toku" : r.money === "full" ? "pieniądze zwrócone" : ret === "RETURNED" ? "towar zwrócony" : "zwrot";
    return { status: "returned", detail };
  }
  if (ret === "IN_PROGRESS" || ret === "RETURN_REQUESTED") return { status: "problem", detail: ret === "RETURN_REQUESTED" ? "klient prosi o zwrot" : "zwrot w toku – klient odsyła towar" };
  if (ret === "RETURN_FAILED") return { status: "problem", detail: "zwrot nieudany" };
  // Zarchiwizowane w Shopify = zamówienie zakończone.
  if (o.closed_at) return { status: "delivered", detail: r.money === "partial" ? "zarchiwizowane · częściowy zwrot" : "zarchiwizowane w Shopify" };

  const active = shipments
    .map((s) => ({ s, kind: classifyShipment(s) }))
    .filter((x): x is { s: ShipmentLike; kind: "shipped" | "delivered" | "problem" } => x.kind !== null)
    .sort((a, b) => (b.s.state_at ?? "").localeCompare(a.s.state_at ?? ""));
  if (active.length) {
    const problem = active.find((x) => x.kind === "problem");
    if (problem) return { status: "problem", detail: problem.s.state_description };
    if (active.every((x) => x.kind === "delivered")) return { status: "delivered", detail: active[0].s.state_description };
    return { status: "shipped", detail: active.find((x) => x.kind === "shipped")?.s.state_description ?? null };
  }

  // „Gotowe do odbioru” (odbiór osobisty) nie liczy się jako wysłane – zamówienie czeka, aż klient je odbierze.
  const done = (o.fulfillments ?? []).filter((f) => !/cancel|error|failure/i.test(f.status) && (f.displayStatus ?? "").toUpperCase() !== "READY_FOR_PICKUP");
  if (!done.length) return { status: "new", detail: null };
  const shown = done.map((f) => (f.displayStatus ?? "").toUpperCase());
  if (shown.some((d) => ["FAILURE", "ATTEMPTED_DELIVERY", "NOT_DELIVERED"].includes(d))) return { status: "problem", detail: "Shopify: problem z doręczeniem" };
  if (shown.every((d) => d === "DELIVERED" || d === "PICKED_UP")) return { status: "delivered", detail: null };
  const tracked = done.some((f) => f.trackingInfo?.some((t) => t.number));
  if (!tracked && isPersonalPickup(o.shipping_method)) return { status: "delivered", detail: "odbiór osobisty" };
  return { status: "shipped", detail: null };
}

const COD = /pobrani|cash on delivery|\bcod\b|przy odbiorze|płatność przy|za pobraniem/i;

export function detectCod(gateways: string[], shippingMethod: string | null | undefined) {
  return gateways.some((g) => COD.test(g)) || COD.test(shippingMethod ?? "");
}

/** Opis płatności dla listy: opłacone / za pobraniem / nieopłacone / zwrot. */
export function paymentLabel(o: RefundFields & { financial_status: string | null; cod: boolean; outstanding?: number | string | null }): { text: string; tone: "green" | "amber" | "red" | "slate" | "blue" } {
  const fs = (o.financial_status ?? "").toUpperCase();
  const r = refundState(o);
  if (r.money === "pending") return { text: "zwrot w toku", tone: "amber" };
  if (r.money === "full") return { text: "zwrócone", tone: "slate" };
  if (r.money === "partial") return { text: "częściowy zwrot", tone: "amber" };
  if (fs === "PAID") return { text: "opłacone", tone: "green" };
  if (o.cod) return { text: "za pobraniem", tone: "blue" };
  if (fs === "PARTIALLY_PAID") return { text: "częściowo opłacone", tone: "amber" };
  if (fs === "VOIDED") return { text: "anulowana płatność", tone: "slate" };
  return { text: "nieopłacone", tone: "red" };
}

const POINT_CODE = /\b(?:POP-)?[A-Z]{3}\d{2,4}[A-Z]{0,3}\b/;
const POINT_METHOD = /paczkomat|parcel locker|locker|inpost|punkt|point|pickup point|automat/i;

/** Kod paczkomatu / punktu z atrybutów zamówienia albo adresu (tylko gdy metoda to punkt odbioru). */
export function detectPickupPoint(
  method: string | null | undefined,
  attributes: { key: string; value: string | null }[],
  address: { address1?: string | null; address2?: string | null; company?: string | null } | null,
): string | null {
  for (const a of attributes) {
    if (/paczkomat|inpost|locker|point|punkt|machine/i.test(a.key)) {
      const m = (a.value ?? "").toUpperCase().match(POINT_CODE);
      if (m) return m[0];
    }
  }
  if (!POINT_METHOD.test(method ?? "")) return null;
  for (const v of [method, address?.company, address?.address2, address?.address1]) {
    const m = (v ?? "").match(POINT_CODE);
    if (m) return m[0];
  }
  return null;
}

/** Jaki przewoźnik i usługa wynikają z metody wysyłki ze sklepu. */
export function guessService(method: string | null | undefined): "inpost_locker" | "inpost_courier" | "dpd" | null {
  const m = method ?? "";
  if (/dpd/i.test(m)) return "dpd";
  if (/inpost/i.test(m) && /kurier|courier/i.test(m)) return "inpost_courier";
  if (/paczkomat|parcel locker|locker/i.test(m)) return "inpost_locker";
  if (/kurier|courier|pobrani|cash on delivery/i.test(m)) return "dpd";
  return null;
}
