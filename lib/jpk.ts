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
  key: string;                 // o:<order id>:<pozycja>:<sztuka> | p:<pos item id> | i:<pozycja faktury>
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

/** Dokument sprzedaży: paragon (ma pierwszeństwo – faktura do paragonu nie jest osobną sprzedażą) albo faktura. */
type Doc = { kind: DocKind; number: string | null; date: string; items?: Receipt["items"] };
type InvoiceRow = { id: string; number: string; issue_date: string; order_id: string | null; pos_order_id: string | null };

/** Data faktury (dzień) jako chwila: północ czasu polskiego. */
function invoiceInstant(day: string) {
  const [y, m, d] = day.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const off = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Warsaw", timeZoneName: "shortOffset" }).formatToParts(new Date(guess)).find((p) => p.type === "timeZoneName")?.value ?? "GMT+1";
  const h = Number(off.replace("GMT", "") || 0);
  return new Date(guess - h * 3600_000).toISOString();
}
const receiptDoc = (r: Receipt | undefined): Doc | undefined => (r ? { kind: "receipt", number: r.number, date: r.issued_at, items: r.items } : undefined);
const invoiceDoc = (i: InvoiceRow | undefined): Doc | undefined => (i ? { kind: "invoice", number: i.number, date: invoiceInstant(i.issue_date) } : undefined);

type Order = {
  id: string; name: string; ordered_at: string; cancelled_at: string | null; status: string; cod: boolean; financial_status: string | null;
  base_order_id: number | null; line_items: LineItem[];
};
const ORDER_FIELDS = "id, name, ordered_at, cancelled_at, status, cod, financial_status, base_order_id, line_items";

type Sale = { id: string; order_id: string; variant_id: string | null; status: string; unit: Unit };

/** Pozycje zamówień ze sklepu (każda sztuka osobno) z przypisanymi sztukami i umowami. */
async function shopLines(db: SupabaseClient, orders: Order[], docOf: (o: Order) => Doc | undefined) {
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
    const r = docOf(o);
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
          key: `o:${o.id}:${li}:${n}`, source: "shop", kind: r?.kind ?? null, docNumber: r?.number ?? null, docDate: r?.date ?? null,
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

async function posLines(db: SupabaseClient, posOrderIds: string[], docOf: (posOrderId: string) => Doc | undefined) {
  if (!posOrderIds.length) return [];
  const items = await inChunks<PosItem>(posOrderIds, (part) =>
    db.from("pos_order_items").select(`id, order_id, price, status, order:pos_orders(id, code, created_at), unit:units(${UNIT_FIELDS}, variant:variants(option, product:products(title)))`)
      .in("order_id", part as string[]));
  return items.map((i): JpkLine => {
    const r = docOf(i.order_id);
    return {
      key: `p:${i.id}`, source: "pos", kind: r?.kind ?? null, docNumber: r?.number ?? null, docDate: r?.date ?? null, saleDate: i.order?.created_at ?? "",
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

async function docsFor(db: SupabaseClient, orders: Order[], posIds: string[]) {
  const baseIds = orders.map((o) => o.base_order_id).filter((x): x is number => !!x).map(Number);
  const [rb, rp, ib, ip] = await Promise.all([
    inChunks<Receipt>(baseIds, (part) => db.from("receipts").select(RECEIPT_FIELDS).in("base_order_id", part as number[]).order("issued_at")),
    inChunks<Receipt>(posIds, (part) => db.from("receipts").select(RECEIPT_FIELDS).in("pos_order_id", part as string[]).order("issued_at")),
    inChunks<InvoiceRow>(orders.map((o) => o.id), (part) => db.from("invoices").select(INVOICE_FIELDS).in("order_id", part as string[]).not("status", "in", "(rejected,cancelled)")),
    inChunks<InvoiceRow>(posIds, (part) => db.from("invoices").select(INVOICE_FIELDS).in("pos_order_id", part as string[]).not("status", "in", "(rejected,cancelled)")),
  ]);
  const byBase = new Map<number, Receipt>();
  const byPos = new Map<string, Receipt>();
  for (const r of rb) if (r.base_order_id && !byBase.has(Number(r.base_order_id))) byBase.set(Number(r.base_order_id), r);
  for (const r of rp) if (r.pos_order_id && !byPos.has(r.pos_order_id)) byPos.set(r.pos_order_id, r);
  const invByOrder = new Map(ib.map((i) => [i.order_id as string, i]));
  const invByPos = new Map(ip.map((i) => [i.pos_order_id as string, i]));
  return {
    orderDoc: (o: Order) => receiptDoc(o.base_order_id ? byBase.get(Number(o.base_order_id)) : undefined) ?? invoiceDoc(invByOrder.get(o.id)),
    posDoc: (id: string) => receiptDoc(byPos.get(id)) ?? invoiceDoc(invByPos.get(id)),
  };
}

const INVOICE_FIELDS = "id, number, issue_date, order_id, pos_order_id";

type InvoiceItemRow = { id: string; name: string; total_gross: number; vat: string; invoice: InvoiceRow; unit: Unit };

/** Faktury wystawione ręcznie (bez zamówienia i kasy) – pozycje z faktury. */
async function manualInvoiceLines(db: SupabaseClient, invoiceIds: string[]) {
  const items = await inChunks<InvoiceItemRow>(invoiceIds, (part) =>
    db.from("invoice_items").select(`id, name, total_gross, vat, invoice:invoices(${INVOICE_FIELDS}), unit:units(${UNIT_FIELDS})`).in("invoice_id", part as string[]));
  return items.map((i): JpkLine => ({
    key: `i:${i.id}`, source: "shop", kind: "invoice", docNumber: i.invoice.number, docDate: invoiceInstant(i.invoice.issue_date), saleDate: invoiceInstant(i.invoice.issue_date),
    name: i.name, price: Number(i.total_gross), vat: i.unit ? vatOf(i.unit) : i.vat === "23" ? "A" : "F", ...unitPart(i.unit),
    orderLabel: i.invoice.number, orderHref: `/sprzedaz/faktury/${i.invoice.id}`, saleNote: null,
  }));
}

/**
 * Sprzedaże miesiąca: z dokumentem wystawionym w tym miesiącu albo – bez dokumentu – złożone w tym miesiącu
 * (anulowane bez dokumentu pomijane).
 */
export async function loadJpkLines(db: SupabaseClient, opts: { from: Date; to: Date; kind: "all" | DocKind | "none" }): Promise<JpkLine[]> {
  const from = opts.from.toISOString();
  const to = opts.to.toISOString();
  const fromDay = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw" }).format(opts.from);
  const toDay = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw" }).format(opts.to);
  const [{ data: monthReceipts, error: e1 }, { data: monthOrders, error: e2 }, { data: monthPos, error: e3 }, { data: monthInvoices, error: e4 }] = await Promise.all([
    db.from("receipts").select("base_order_id, pos_order_id").gte("issued_at", from).lt("issued_at", to).limit(10000),
    db.from("orders").select("id").gte("ordered_at", from).lt("ordered_at", to).limit(10000),
    db.from("pos_orders").select("id").gte("created_at", from).lt("created_at", to).limit(10000),
    db.from("invoices").select(INVOICE_FIELDS).gte("issue_date", fromDay).lt("issue_date", toDay).not("status", "in", "(rejected,cancelled)").limit(10000),
  ]);
  if (e1 || e2 || e3 || e4) throw e1 ?? e2 ?? e3 ?? e4;
  const invoicesM = (monthInvoices ?? []) as InvoiceRow[];
  const recBase = [...new Set((monthReceipts ?? []).map((r) => r.base_order_id).filter((x): x is number => !!x).map(Number))];
  const docPos = [...new Set([...(monthReceipts ?? []).map((r) => r.pos_order_id), ...invoicesM.map((i) => i.pos_order_id)].filter((x): x is string => !!x))];

  const ordersByReceipt = await inChunks<Order>(recBase, (part) => db.from("orders").select(ORDER_FIELDS).in("base_order_id", part as number[]));
  const known = new Set(ordersByReceipt.map((o) => o.id));
  const extraIds = [...new Set([...(monthOrders ?? []).map((o) => o.id as string), ...invoicesM.map((i) => i.order_id).filter((x): x is string => !!x)])].filter((id) => !known.has(id));
  const ordersMore = await inChunks<Order>(extraIds, (part) => db.from("orders").select(ORDER_FIELDS).in("id", part as string[]));
  const orders = [...ordersByReceipt, ...ordersMore];
  const posIds = [...new Set([...docPos, ...(monthPos ?? []).map((p) => p.id as string)])];

  const { orderDoc, posDoc } = await docsFor(db, orders, posIds);
  const inMonth = (d: string | null) => !!d && d >= from && d < to;
  const posInMonth = new Set((monthPos ?? []).map((p) => p.id as string));

  const keepOrders = orders.filter((o) => {
    const d = orderDoc(o);
    if (d) return inMonth(d.date);
    return !o.cancelled_at && inMonth(o.ordered_at);
  });
  const keepPos = posIds.filter((id) => {
    const d = posDoc(id);
    return d ? inMonth(d.date) : posInMonth.has(id);
  });
  const manual = invoicesM.filter((i) => !i.order_id && !i.pos_order_id).map((i) => i.id);

  const lines = [
    ...(await shopLines(db, keepOrders, orderDoc)),
    ...(await posLines(db, keepPos, posDoc)),
    ...(await manualInvoiceLines(db, manual)),
  ];
  const filtered = opts.kind === "all" ? lines : opts.kind === "none" ? lines.filter((l) => !l.kind) : lines.filter((l) => l.kind === opts.kind);
  return sortLines(filtered);
}

/** Linie po kluczach (eksport zaznaczonych). */
export async function loadJpkLinesByKeys(db: SupabaseClient, keys: string[]) {
  const orderIds = [...new Set(keys.filter((k) => k.startsWith("o:")).map((k) => k.split(":")[1]))];
  const posItemIds = keys.filter((k) => k.startsWith("p:")).map((k) => k.slice(2));
  const invItemIds = keys.filter((k) => k.startsWith("i:")).map((k) => k.slice(2));
  const orders = await inChunks<Order>(orderIds, (part) => db.from("orders").select(ORDER_FIELDS).in("id", part as string[]));
  const posItems = await inChunks<{ order_id: string }>(posItemIds, (part) => db.from("pos_order_items").select("order_id").in("id", part as string[]));
  const invItems = await inChunks<{ invoice_id: string }>(invItemIds, (part) => db.from("invoice_items").select("invoice_id").in("id", part as string[]));
  const posIds = [...new Set(posItems.map((p) => p.order_id))];
  const { orderDoc, posDoc } = await docsFor(db, orders, posIds);
  const want = new Set(keys);
  const lines = [
    ...(await shopLines(db, orders, orderDoc)),
    ...(await posLines(db, posIds, posDoc)),
    ...(await manualInvoiceLines(db, [...new Set(invItems.map((i) => i.invoice_id))])),
  ].filter((l) => want.has(l.key));
  return sortLines(lines);
}
