import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LineItem } from "@/lib/sync/shop-orders";

/**
 * JPK: wszystkie sprzedaże – zamówienia ze sklepów (pozycje z Shopify) i sprzedaż stacjonarna – z dokumentem
 * sprzedaży (paragon / faktura) albo bez niego. Pomijane są tylko anulowane zamówienia bez dokumentu.
 * Dane zakupu (data, kwota, numer umowy, waluta) pochodzą z umowy sztuki przypisanej do pozycji.
 */

export type DocKind = "receipt" | "invoice";

export type JpkLine = {
  key: string;                 // o:<order id>:<pozycja>:<sztuka> | p:<pos item id>
  source: "shop" | "pos";
  kind: DocKind | null;
  docNumber: string | null;
  docDate: string | null;      // ISO
  saleDate: string;
  name: string;
  price: number | null;
  vat: "A" | "F" | "";
  unitId: string | null;
  unitCode: string | null;
  contractId: string | null;
  contractNumber: string | null;
  contractDate: string | null;
  purchasePrice: number | null;
  currency: string | null;     // waluta umowy
  orderLabel: string;
  orderHref: string | null;
  saleNote: string | null;     // ZWROT, NIE ODEBRANE POBRANIE, ANULOWANE
};

type Contract = { id: string; number: number | null; doc_number: string | null; contract_date: string | null; currency: string | null; template: string | null };
type Unit = { id: string; code: string; owner_type: string; purchase_form: string; purchase_price: number | null; payout_amount: number | null; contract: Contract | null } | null;

const UNIT_FIELDS = "id, code, owner_type, purchase_form, purchase_price, payout_amount, contract:contracts(id, number, doc_number, contract_date, currency, template)";

/** Numer umowy: odczytany z dokumentu (skan) albo numer umowy z szablonu. */
export function contractLabel(c: Pick<Contract, "number" | "doc_number" | "template"> | null) {
  if (!c) return null;
  if (c.doc_number) return c.doc_number;
  return c.template && c.number ? String(c.number) : null;
}

function vatOf(unit: Unit, taxRate?: number | null): JpkLine["vat"] {
  if (unit) return unit.purchase_form === "vat_23" ? "A" : "F";
  if (taxRate === 23) return "A";
  if (taxRate !== undefined && taxRate !== null) return "F";
  return "";
}

function unitPart(u: Unit) {
  const price = u ? (u.owner_type === "consignment" ? u.payout_amount : u.purchase_price) : null;
  return {
    unitId: u?.id ?? null,
    unitCode: u?.code ?? null,
    contractId: u?.contract?.id ?? null,
    contractNumber: contractLabel(u?.contract ?? null),
    contractDate: u?.contract?.contract_date ?? null,
    purchasePrice: price === null || price === undefined ? null : Number(price),
    currency: u?.contract?.currency ?? null,
  };
}

async function inChunks<T>(ids: (string | number)[], fn: (part: (string | number)[]) => PromiseLike<{ data: unknown; error: unknown }>) {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await fn(ids.slice(i, i + 200));
    if (error) throw error;
    out.push(...((data ?? []) as T[]));
  }
  return out;
}

type Receipt = { number: string | null; issued_at: string; base_order_id: number | null; pos_order_id: string | null; items: { name: string; price_brutto: number; tax_rate: number }[] };
const RECEIPT_FIELDS = "number, issued_at, base_order_id, pos_order_id, items";

type Order = {
  id: string; name: string; ordered_at: string; cancelled_at: string | null; status: string; cod: boolean; financial_status: string | null;
  base_order_id: number | null; line_items: LineItem[];
};
const ORDER_FIELDS = "id, name, ordered_at, cancelled_at, status, cod, financial_status, base_order_id, line_items";

type Sale = { id: string; order_id: string; variant_id: string | null; status: string; unit: Unit };

/** Pozycje zamówień ze sklepu (każda sztuka osobno) z przypisanymi sztukami i umowami. */
async function shopLines(db: SupabaseClient, orders: Order[], receiptOf: Map<number, Receipt>) {
  if (!orders.length) return [];
  const sales = await inChunks<Sale>(orders.map((o) => o.id), (part) =>
    db.from("sales").select(`id, order_id, variant_id, status, unit:units(${UNIT_FIELDS})`).in("order_id", part as string[]));
  const gids = [...new Set(orders.flatMap((o) => o.line_items.map((l) => l.shopify_variant_id).filter((x): x is string => !!x)))];
  const links = await inChunks<{ variant_id: string; shopify_variant_id: string }>(gids, (part) =>
    db.from("variant_store_links").select("variant_id, shopify_variant_id").in("shopify_variant_id", part as string[]));
  const variantOf = new Map(links.map((l) => [l.shopify_variant_id, l.variant_id]));
  const salesBy = new Map<string, Sale[]>();
  for (const s of sales) salesBy.set(s.order_id, [...(salesBy.get(s.order_id) ?? []), s]);

  const lines: JpkLine[] = [];
  for (const o of orders) {
    const r = o.base_order_id ? receiptOf.get(o.base_order_id) : undefined;
    const pool = [...(salesBy.get(o.id) ?? [])];
    const orderNote = o.cancelled_at
      ? (o.cod && o.status === "problem" ? "NIE ODEBRANE POBRANIE" : "ANULOWANE")
      : (o.financial_status ?? "").toUpperCase() === "REFUNDED" ? "ZWROT" : null;
    o.line_items.forEach((l, li) => {
      if (l.service) return;
      const variantId = l.shopify_variant_id ? variantOf.get(l.shopify_variant_id) : undefined;
      for (let n = 0; n < Math.max(1, l.quantity); n++) {
        const idx = pool.findIndex((s) => variantId && s.variant_id === variantId);
        const sale = idx >= 0 ? pool.splice(idx, 1)[0] : null;
        const item = r?.items?.find((i) => i.name && l.title && i.name.toLowerCase().includes(l.title.toLowerCase().slice(0, 12)));
        lines.push({
          key: `o:${o.id}:${li}:${n}`, source: "shop", kind: r ? "receipt" : null, docNumber: r?.number ?? null, docDate: r?.issued_at ?? null,
          saleDate: o.ordered_at, name: [l.title, l.variant_title].filter(Boolean).join(" "), price: Number(l.price),
          vat: vatOf(sale?.unit ?? null, item?.tax_rate), ...unitPart(sale?.unit ?? null),
          orderLabel: o.name, orderHref: `/sprzedaz/${o.id}`,
          saleNote: orderNote ?? (sale?.status === "cancelled" ? "ZWROT" : null),
        });
      }
    });
  }
  return lines;
}

type PosItem = {
  id: string; order_id: string; price: number; status: string;
  order: { id: string; code: string; created_at: string } | null;
  unit: (NonNullable<Unit> & { variant: { option: string; product: { title: string } } | null }) | null;
};

async function posLines(db: SupabaseClient, posOrderIds: string[], receiptOf: Map<string, Receipt>) {
  if (!posOrderIds.length) return [];
  const items = await inChunks<PosItem>(posOrderIds, (part) =>
    db.from("pos_order_items").select(`id, order_id, price, status, order:pos_orders(id, code, created_at), unit:units(${UNIT_FIELDS}, variant:variants(option, product:products(title)))`)
      .in("order_id", part as string[]));
  return items.map((i): JpkLine => {
    const r = receiptOf.get(i.order_id);
    return {
      key: `p:${i.id}`, source: "pos", kind: r ? "receipt" : null, docNumber: r?.number ?? null, docDate: r?.issued_at ?? null, saleDate: i.order?.created_at ?? "",
      name: i.unit?.variant ? `${i.unit.variant.product.title} ${i.unit.variant.option}` : "",
      price: Number(i.price), vat: vatOf(i.unit), ...unitPart(i.unit),
      orderLabel: i.order?.code ?? "", orderHref: i.order ? `/kasa/${i.order.id}` : null,
      saleNote: i.status === "returned" ? "ZWROT" : null,
    };
  });
}

export function sortLines(lines: JpkLine[]) {
  return lines.sort((a, b) => (a.docDate ?? a.saleDate).localeCompare(b.docDate ?? b.saleDate)
    || (a.docNumber ?? "").localeCompare(b.docNumber ?? "", "pl", { numeric: true }) || a.name.localeCompare(b.name));
}

async function receiptsFor(db: SupabaseClient, baseIds: number[], posIds: string[]) {
  const [rb, rp] = await Promise.all([
    inChunks<Receipt>(baseIds, (part) => db.from("receipts").select(RECEIPT_FIELDS).in("base_order_id", part as number[]).order("issued_at")),
    inChunks<Receipt>(posIds, (part) => db.from("receipts").select(RECEIPT_FIELDS).in("pos_order_id", part as string[]).order("issued_at")),
  ]);
  const byBase = new Map<number, Receipt>();
  const byPos = new Map<string, Receipt>();
  for (const r of rb) if (r.base_order_id && !byBase.has(Number(r.base_order_id))) byBase.set(Number(r.base_order_id), r);
  for (const r of rp) if (r.pos_order_id && !byPos.has(r.pos_order_id)) byPos.set(r.pos_order_id, r);
  return { byBase, byPos };
}

/**
 * Sprzedaże miesiąca: z dokumentem wystawionym w tym miesiącu albo – bez dokumentu – złożone w tym miesiącu
 * (anulowane bez dokumentu pomijane).
 */
export async function loadJpkLines(db: SupabaseClient, opts: { from: Date; to: Date; kind: "all" | DocKind | "none" }): Promise<JpkLine[]> {
  const from = opts.from.toISOString();
  const to = opts.to.toISOString();
  const [{ data: monthReceipts, error: e1 }, { data: monthOrders, error: e2 }, { data: monthPos, error: e3 }] = await Promise.all([
    db.from("receipts").select("base_order_id, pos_order_id").gte("issued_at", from).lt("issued_at", to).limit(10000),
    db.from("orders").select("id").gte("ordered_at", from).lt("ordered_at", to).limit(10000),
    db.from("pos_orders").select("id").gte("created_at", from).lt("created_at", to).limit(10000),
  ]);
  if (e1 || e2 || e3) throw e1 ?? e2 ?? e3;
  const recBase = [...new Set((monthReceipts ?? []).map((r) => r.base_order_id).filter((x): x is number => !!x).map(Number))];
  const recPos = [...new Set((monthReceipts ?? []).map((r) => r.pos_order_id).filter((x): x is string => !!x))];

  const ordersByReceipt = await inChunks<Order>(recBase, (part) => db.from("orders").select(ORDER_FIELDS).in("base_order_id", part as number[]));
  const extraIds = (monthOrders ?? []).map((o) => o.id as string).filter((id) => !ordersByReceipt.some((o) => o.id === id));
  const ordersInMonth = await inChunks<Order>(extraIds, (part) => db.from("orders").select(ORDER_FIELDS).in("id", part as string[]));
  const orders = [...ordersByReceipt, ...ordersInMonth];
  const posIds = [...new Set([...recPos, ...(monthPos ?? []).map((p) => p.id as string)])];

  const { byBase, byPos } = await receiptsFor(db, orders.map((o) => o.base_order_id).filter((x): x is number => !!x).map(Number), posIds);
  const inMonth = (d: string | null) => !!d && d >= from && d < to;

  const keepOrders = orders.filter((o) => {
    const r = o.base_order_id ? byBase.get(Number(o.base_order_id)) : undefined;
    if (r) return inMonth(r.issued_at);
    return !o.cancelled_at && inMonth(o.ordered_at);
  });
  const keepPos = posIds.filter((id) => {
    const r = byPos.get(id);
    return r ? inMonth(r.issued_at) : true;
  });
  // Sprzedaż stacjonarna bez paragonu tylko z tego miesiąca.
  const posInMonth = new Set((monthPos ?? []).map((p) => p.id as string));

  const lines = [
    ...(await shopLines(db, keepOrders, byBase)),
    ...(await posLines(db, keepPos.filter((id) => byPos.has(id) || posInMonth.has(id)), byPos)),
  ];
  const filtered = opts.kind === "all" ? lines : opts.kind === "none" ? lines.filter((l) => !l.kind) : lines.filter((l) => l.kind === opts.kind);
  return sortLines(filtered);
}

/** Linie po kluczach (eksport zaznaczonych). */
export async function loadJpkLinesByKeys(db: SupabaseClient, keys: string[]) {
  const orderIds = [...new Set(keys.filter((k) => k.startsWith("o:")).map((k) => k.split(":")[1]))];
  const posItemIds = keys.filter((k) => k.startsWith("p:")).map((k) => k.slice(2));
  const orders = await inChunks<Order>(orderIds, (part) => db.from("orders").select(ORDER_FIELDS).in("id", part as string[]));
  const posItems = await inChunks<{ order_id: string }>(posItemIds, (part) => db.from("pos_order_items").select("order_id").in("id", part as string[]));
  const posIds = [...new Set(posItems.map((p) => p.order_id))];
  const { byBase, byPos } = await receiptsFor(db, orders.map((o) => o.base_order_id).filter((x): x is number => !!x).map(Number), posIds);
  const want = new Set(keys);
  const lines = [...(await shopLines(db, orders, byBase)), ...(await posLines(db, posIds, byPos))].filter((l) => want.has(l.key));
  return sortLines(lines);
}
