import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LineItem } from "@/lib/sync/shop-orders";
import { matchPieces } from "@/lib/orders/pieces";
import { contractStage, type ContractStage } from "@/lib/contracts/stage";
import { isParOrder } from "@/lib/orders/par-order";

/**
 * JPK: sprzedaże z dokumentem – faktury wysłane do KSeF, paragony fiskalne do sprzedaży stacjonarnej i do zamówień
 * ze sklepów. Data i miesiąc = data wystawienia dokumentu. Paragony PAR (bez KSeF) i zamówienia „wysyłka z PAR”
 * nie wchodzą. Dane zakupu (data, kwota, numer umowy, waluta) pochodzą z umowy sztuki przypisanej do pozycji.
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
  vat: string;                 // litera stawki PTU (A 23%, F marża…) albo pusto
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
  saleId: string | null;       // linia sprzedaży (do dołączenia umowy, gdy nie ma sztuki)
  variantLinked: boolean;      // produkt powiązany z katalogiem (można utworzyć sztukę)
  baseOrderId: number | null;  // zamówienie w Base (pobranie paragonu z Base)
  pieceRef: string | null;     // <zamówienie>|<pozycja>|<sztuka> – „Dołącz umowę” także bez linii sprzedaży
  pendingContractId: string | null; // umowa w toku (czeka na podpis) do sprzedaży bez sztuki
  contractStage: ContractStage | null; // etap umowy sztuki (w toku / gotowa)
  consignorWait: boolean;      // rzecz komisanta bez umowy – czeka na umowę / fakturę od komisanta
};

type Contract = { id: string; number: number | null; doc_number: string | null; contract_date: string | null; currency: string | null; template: string | null; status: string; paid_at: string | null; source: string | null };
type Unit = { id: string; code: string; owner_type: string; purchase_form: string; purchase_price: number | null; payout_amount: number | null; contract: Contract | null } | null;

const UNIT_FIELDS = "id, code, owner_type, purchase_form, purchase_price, payout_amount, contract:contracts(id, number, doc_number, contract_date, currency, template, status, paid_at, source)";

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
    contractStage: u?.contract ? contractStage(u.contract) : null,
    consignorWait: !!u && u.owner_type === "consignment" && !u.contract,
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

type Receipt = { number: string | null; issued_at: string; base_order_id: number | null; pos_order_id: string | null; source: string; items: { name: string; price_brutto: number; tax_rate: number }[] };
const RECEIPT_FIELDS = "number, issued_at, base_order_id, pos_order_id, source, items";

/** Dokument sprzedaży: paragon (ma pierwszeństwo – faktura do paragonu nie jest osobną sprzedażą) albo faktura. */
type Doc = { kind: DocKind; number: string | null; date: string; items?: Receipt["items"] };
type InvoiceRow = { id: string; number: string; issue_date: string; order_id: string | null; pos_order_id: string | null; kind?: string | null };

/** Data faktury (dzień) jako chwila: północ czasu polskiego. */
function invoiceInstant(day: string) {
  const [y, m, d] = day.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const off = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Warsaw", timeZoneName: "shortOffset" }).formatToParts(new Date(guess)).find((p) => p.type === "timeZoneName")?.value ?? "GMT+1";
  const h = Number(off.replace("GMT", "") || 0);
  return new Date(guess - h * 3600_000).toISOString();
}
const receiptDoc = (r: Receipt | undefined): Doc | undefined => (r ? { kind: "receipt", number: r.number, date: r.issued_at, items: r.items } : undefined);
const invoiceDoc = (i: InvoiceRow | undefined): Doc | undefined => (i ? { kind: i.kind === "receipt" ? "receipt" : "invoice", number: i.number, date: invoiceInstant(i.issue_date) } : undefined);

type Order = {
  id: string; name: string; ordered_at: string; cancelled_at: string | null; status: string; cod: boolean; financial_status: string | null;
  base_order_id: number | null; line_items: LineItem[]; shopify_order_id: string;
};
const ORDER_FIELDS = "id, name, ordered_at, cancelled_at, status, cod, financial_status, base_order_id, line_items, shopify_order_id";

type Sale = { id: string; order_id: string; variant_id: string | null; status: string; shopify_line_id: string | null; shopify_line_index: number | null; unit: Unit };

/** Pozycje zamówień ze sklepu (każda sztuka osobno) z przypisanymi sztukami i umowami. */
async function shopLines(db: SupabaseClient, orders: Order[], docOf: (o: Order) => Doc | undefined) {
  if (!orders.length) return [];
  const sales = await inChunks<Sale>(orders.map((o) => o.id), (part) =>
    db.from("sales").select(`id, order_id, variant_id, status, shopify_line_id, shopify_line_index, unit:units(${UNIT_FIELDS})`).in("order_id", part as string[]));
  const gids = [...new Set(orders.flatMap((o) => o.line_items.map((l) => l.shopify_variant_id).filter((x): x is string => !!x)))];
  const links = await inChunks<{ variant_id: string; shopify_variant_id: string }>(gids, (part) =>
    db.from("variant_store_links").select("variant_id, shopify_variant_id").in("shopify_variant_id", part as string[]));
  const variantOf = new Map(links.map((l) => [l.shopify_variant_id, l.variant_id]));
  const salesBy = new Map<string, Sale[]>();
  for (const s of sales) salesBy.set(s.order_id, [...(salesBy.get(s.order_id) ?? []), s]);
  // Umowy w toku do sprzedaży bez sztuki (link do podpisu wysłany).
  const noUnit = sales.filter((s) => !s.unit).map((s) => s.id);
  const pending = await inChunks<{ id: string; sale_id: string }>(noUnit, (part) =>
    db.from("contracts").select("id, sale_id").in("sale_id", part as string[]).not("status", "in", "(cancelled,rejected)"));
  const pendingBy = new Map(pending.map((c) => [c.sale_id, c.id]));

  const lines: JpkLine[] = [];
  for (const o of orders) {
    const r = docOf(o);
    const orderNote = o.cancelled_at
      ? (o.cod && o.status === "problem" ? "NIE ODEBRANE POBRANIE" : "ANULOWANE")
      : (o.financial_status ?? "").toUpperCase() === "REFUNDED" || o.status === "returned" ? "ZWROT" : null;
    for (const p of matchPieces(o.id, o.line_items, salesBy.get(o.id) ?? [], (g) => variantOf.get(g))) {
      const l = p.line;
      const sale = p.sale;
      const item = r?.items?.find((i) => i.name && l.title && i.name.toLowerCase().includes(l.title.toLowerCase().slice(0, 12)));
      lines.push({
        key: `o:${o.id}:${p.lineIndex}:${p.n}`, source: "shop", kind: r?.kind ?? null, docNumber: r?.number ?? null, docDate: r?.date ?? null,
        saleDate: o.ordered_at, name: [l.title, l.variant_title].filter(Boolean).join(" "), price: Number(l.price),
        vat: vatOf(sale?.unit ?? null, item?.tax_rate), ...unitPart(sale?.unit ?? null),
        orderLabel: o.name, orderHref: `/sprzedaz/${o.id}`,
        saleNote: orderNote ?? (sale?.status === "cancelled" ? "ZWROT" : null),
        saleId: sale?.id ?? null, variantLinked: !!p.variantId, baseOrderId: o.base_order_id ? Number(o.base_order_id) : null,
        pieceRef: p.ref, pendingContractId: sale && !sale.unit ? pendingBy.get(sale.id) ?? null : null,
      });
    }
  }
  return lines;
}

type PosItem = {
  id: string; order_id: string; price: number; status: string; name: string | null; ptu: string | null; quantity: number | null;
  order: { id: string; code: string; created_at: string } | null;
  unit: (NonNullable<Unit> & { variant: { option: string; product: { title: string } } | null }) | null;
};

async function posLines(db: SupabaseClient, posOrderIds: string[], docOf: (posOrderId: string) => Doc | undefined) {
  if (!posOrderIds.length) return [];
  const items = await inChunks<PosItem>(posOrderIds, (part) =>
    db.from("pos_order_items").select(`id, order_id, price, status, name, ptu, quantity, order:pos_orders(id, code, created_at), unit:units(${UNIT_FIELDS}, variant:variants(option, product:products(title)))`)
      .in("order_id", part as string[]));
  return items.map((i): JpkLine => {
    const r = docOf(i.order_id);
    const qty = Number(i.quantity ?? 1);
    return {
      key: `p:${i.id}`, source: "pos", kind: r?.kind ?? null, docNumber: r?.number ?? null, docDate: r?.date ?? null, saleDate: i.order?.created_at ?? "",
      // Pozycja spoza magazynu (wpisana w Kasie / własny produkt): nazwa i litera PTU z Kasy.
      name: i.unit?.variant ? `${i.unit.variant.product.title} ${i.unit.variant.option}` : `${i.name ?? ""}${qty !== 1 ? ` × ${qty}` : ""}`,
      price: Math.round(Number(i.price) * qty * 100) / 100, vat: i.unit ? vatOf(i.unit) : ((i.ptu ?? "") as JpkLine["vat"]), ...unitPart(i.unit),
      orderLabel: i.order?.code ?? "", orderHref: i.order ? `/kasa/${i.order.id}` : null,
      saleNote: i.status === "returned" ? "ZWROT" : null,
      saleId: null, variantLinked: true, baseOrderId: null, pieceRef: null, pendingContractId: null,
    };
  });
}

export type JpkSort = "data_asc" | "data_desc" | "kwota_desc" | "kwota_asc";

export function sortBy(lines: JpkLine[], sort: JpkSort) {
  const d = (l: JpkLine) => l.docDate ?? l.saleDate;
  const sorted = sortLines(lines);
  if (sort === "data_desc") return sorted.reverse();
  if (sort === "kwota_desc") return sorted.sort((a, b) => (b.price ?? 0) - (a.price ?? 0) || d(a).localeCompare(d(b)));
  if (sort === "kwota_asc") return sorted.sort((a, b) => (a.price ?? 0) - (b.price ?? 0) || d(a).localeCompare(d(b)));
  return sorted;
}

export function sortLines(lines: JpkLine[]) {
  return lines.sort((a, b) => (a.docDate ?? a.saleDate).localeCompare(b.docDate ?? b.saleDate)
    || (a.docNumber ?? "").localeCompare(b.docNumber ?? "", "pl", { numeric: true }) || a.name.localeCompare(b.name));
}

async function docsFor(db: SupabaseClient, orders: Order[], posIds: string[]) {
  const baseIds = orders.map((o) => o.base_order_id).filter((x): x is number => !!x).map(Number);
  const [rb, rp, ib, ip, ro] = await Promise.all([
    inChunks<Receipt>(baseIds, (part) => db.from("receipts").select(RECEIPT_FIELDS).in("base_order_id", part as number[]).order("issued_at")),
    inChunks<Receipt>(posIds, (part) => db.from("receipts").select(RECEIPT_FIELDS).in("pos_order_id", part as string[]).order("issued_at")),
    inChunks<InvoiceRow>(orders.map((o) => o.id), (part) => db.from("invoices").select(INVOICE_FIELDS).in("order_id", part as string[]).neq("kind", "receipt").in("status", KSEF_SENT)),
    inChunks<InvoiceRow>(posIds, (part) => db.from("invoices").select(INVOICE_FIELDS).in("pos_order_id", part as string[]).neq("kind", "receipt").in("status", KSEF_SENT)),
    // Paragony z naszej drukarki fiskalnej do zamówień ze sklepu (bez migracji 0036 – brak kolumny, pomijamy).
    inChunks<Receipt & { order_id: string }>(orders.map((o) => o.id), (part) => db.from("receipts").select(`${RECEIPT_FIELDS}, order_id`).in("order_id", part as string[]).order("issued_at")).catch(() => []),
  ]);
  const byOrder = new Map<string, Receipt>();
  for (const r of ro) if (!byOrder.has(r.order_id)) byOrder.set(r.order_id, r);
  const byBase = new Map<number, Receipt>();
  const byPos = new Map<string, Receipt>();
  // Paragon z naszego systemu (drukarka / ręczny) ma pierwszeństwo przed paragonem z Base.
  const better = (cur: Receipt | undefined, r: Receipt) => !cur || (cur.source === "base" && r.source !== "base");
  for (const r of rb) if (r.base_order_id && better(byBase.get(Number(r.base_order_id)), r)) byBase.set(Number(r.base_order_id), r);
  for (const r of rp) if (r.pos_order_id && better(byPos.get(r.pos_order_id), r)) byPos.set(r.pos_order_id, r);
  // Paragony PAR (z modułu faktur, bez KSeF) nie trafiają do JPK – liczą się faktury FVM (KSeF) i paragony z kasy / Base.
  const invByOrder = new Map(ib.map((i) => [i.order_id as string, i]));
  const invByPos = new Map(ip.map((i) => [i.pos_order_id as string, i]));
  return {
    orderDoc: (o: Order) => receiptDoc(byOrder.get(o.id)) ?? receiptDoc(o.base_order_id ? byBase.get(Number(o.base_order_id)) : undefined) ?? invoiceDoc(invByOrder.get(o.id)),
    posDoc: (id: string) => receiptDoc(byPos.get(id)) ?? invoiceDoc(invByPos.get(id)),
  };
}

const INVOICE_FIELDS = "id, number, issue_date, order_id, pos_order_id, kind";
/** Do JPK trafiają tylko faktury wysłane do KSeF (przyjęte albo w trakcie przyjmowania); paragony PAR nigdy. */
const KSEF_SENT = ["accepted", "sending"];

type InvoiceItemRow = { id: string; name: string; total_gross: number; vat: string; invoice: InvoiceRow; unit: Unit };

/** Faktury wystawione ręcznie (bez zamówienia i kasy) – pozycje z faktury. */
async function manualInvoiceLines(db: SupabaseClient, invoiceIds: string[]) {
  const items = await inChunks<InvoiceItemRow>(invoiceIds, (part) =>
    db.from("invoice_items").select(`id, name, total_gross, vat, invoice:invoices(${INVOICE_FIELDS}), unit:units(${UNIT_FIELDS})`).in("invoice_id", part as string[]));
  return items.map((i): JpkLine => ({
    key: `i:${i.id}`, source: "shop", kind: i.invoice.kind === "receipt" ? "receipt" : "invoice", docNumber: i.invoice.number, docDate: invoiceInstant(i.invoice.issue_date), saleDate: invoiceInstant(i.invoice.issue_date),
    name: i.name, price: Number(i.total_gross), vat: i.unit ? vatOf(i.unit) : i.vat === "23" ? "A" : "F", ...unitPart(i.unit),
    orderLabel: i.invoice.number, orderHref: `/sprzedaz/faktury/${i.invoice.id}`, saleNote: null,
    saleId: null, variantLinked: false, baseOrderId: null, pieceRef: null, pendingContractId: null,
  }));
}

type OrphanReceipt = { id: string; number: string | null; issued_at: string; sale_ref: string | null; items: { name: string; price_brutto: number; tax_rate: number; quantity?: number; ptu?: string }[] };

/**
 * Paragony fiskalne, których sprzedaż została usunięta (albo nigdy nie była powiązana): zostają w JPK
 * z pozycjami zapisanymi przy wydruku – paragon z drukarki fiskalnej nie znika z ewidencji.
 */
function orphanReceiptLines(receipts: OrphanReceipt[]): JpkLine[] {
  return receipts.flatMap((r) => (r.items ?? []).map((it, k): JpkLine => {
    const qty = Number(it.quantity ?? 1);
    return {
      key: `r:${r.id}:${k}`, source: "pos", kind: "receipt", docNumber: r.number, docDate: r.issued_at, saleDate: r.issued_at,
      name: `${it.name}${qty !== 1 ? ` × ${qty}` : ""}`, price: Math.round(Number(it.price_brutto) * qty * 100) / 100,
      vat: it.ptu ?? (Number(it.tax_rate) === 23 ? "A" : "F"), unitId: null, unitCode: null,
      contractId: null, contractNumber: null, contractDate: null, purchasePrice: null, currency: null, contractStage: null, consignorWait: false,
      orderLabel: r.sale_ref ?? `paragon ${r.number ?? ""}`, orderHref: null, saleNote: "SPRZEDAŻ USUNIĘTA",
      saleId: null, variantLinked: false, baseOrderId: null, pieceRef: null, pendingContractId: null,
    };
  }));
}
const ORPHAN_FIELDS = "id, number, issued_at, sale_ref, items";

async function orphanReceipts(db: SupabaseClient, q: { from?: string; to?: string; ids?: string[] }) {
  let query = db.from("receipts").select(ORPHAN_FIELDS).neq("source", "base").is("pos_order_id", null).is("order_id", null).is("base_order_id", null).limit(5000);
  if (q.from) query = query.gte("issued_at", q.from);
  if (q.to) query = query.lt("issued_at", q.to);
  if (q.ids) query = query.in("id", q.ids);
  const { data, error } = await query;
  if (error) {
    // Bez migracji 0046 (brak kolumny sale_ref) – bez opisu sprzedaży.
    let q2 = db.from("receipts").select("id, number, issued_at, items").neq("source", "base").is("pos_order_id", null).is("order_id", null).is("base_order_id", null).limit(5000);
    if (q.from) q2 = q2.gte("issued_at", q.from);
    if (q.to) q2 = q2.lt("issued_at", q.to);
    if (q.ids) q2 = q2.in("id", q.ids);
    const { data: d2 } = await q2;
    return ((d2 ?? []) as Omit<OrphanReceipt, "sale_ref">[]).map((r) => ({ ...r, sale_ref: null }));
  }
  return (data ?? []) as OrphanReceipt[];
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
  const [{ data: monthReceipts, error: e1 }, { data: monthOrders, error: e2 }, { data: monthPos, error: e3 }, { data: monthInvoices, error: e4 }, monthPrinted] = await Promise.all([
    db.from("receipts").select("base_order_id, pos_order_id").gte("issued_at", from).lt("issued_at", to).limit(10000),
    db.from("orders").select("id").gte("ordered_at", from).lt("ordered_at", to).limit(10000),
    db.from("pos_orders").select("id").gte("created_at", from).lt("created_at", to).limit(10000),
    db.from("invoices").select(INVOICE_FIELDS).gte("issue_date", fromDay).lt("issue_date", toDay).neq("kind", "receipt").in("status", KSEF_SENT).limit(10000),
    db.from("receipts").select("order_id").not("order_id", "is", null).gte("issued_at", from).lt("issued_at", to).limit(10000),
  ]);
  if (e1 || e2 || e3 || e4) throw e1 ?? e2 ?? e3 ?? e4;
  const invoicesM = (monthInvoices ?? []) as InvoiceRow[];
  const recBase = [...new Set((monthReceipts ?? []).map((r) => r.base_order_id).filter((x): x is number => !!x).map(Number))];
  const docPos = [...new Set([...(monthReceipts ?? []).map((r) => r.pos_order_id), ...invoicesM.map((i) => i.pos_order_id)].filter((x): x is string => !!x))];

  const ordersByReceipt = await inChunks<Order>(recBase, (part) => db.from("orders").select(ORDER_FIELDS).in("base_order_id", part as number[]));
  const known = new Set(ordersByReceipt.map((o) => o.id));
  const printedOrders = monthPrinted.error ? [] : (monthPrinted.data ?? []).map((r) => r.order_id as string);
  const extraIds = [...new Set([...(monthOrders ?? []).map((o) => o.id as string), ...printedOrders, ...invoicesM.map((i) => i.order_id).filter((x): x is string => !!x)])].filter((id) => !known.has(id));
  const ordersMore = await inChunks<Order>(extraIds, (part) => db.from("orders").select(ORDER_FIELDS).in("id", part as string[]));
  const orders = [...ordersByReceipt, ...ordersMore];
  const posIds = [...new Set([...docPos, ...(monthPos ?? []).map((p) => p.id as string)])];

  const { orderDoc, posDoc } = await docsFor(db, orders, posIds);
  const inMonth = (d: string | null) => !!d && d >= from && d < to;
  const posInMonth = new Set((monthPos ?? []).map((p) => p.id as string));

  const keepOrders = orders.filter((o) => {
    // Wysyłka z paragonu PAR – sprzedaż poza JPK.
    if (isParOrder(o.shopify_order_id)) return false;
    const d = orderDoc(o);
    if (d) return inMonth(d.date);
    return !o.cancelled_at && inMonth(o.ordered_at);
  });
  // Sprzedaż z Kasy z samym paragonem PDF (PAR, bez fiskalnego) – poza JPK, także poza „bez dokumentu”.
  const parPos = new Set((await inChunks<{ pos_order_id: string }>(posIds, (part) => db.from("invoices").select("pos_order_id").in("pos_order_id", part as string[]).eq("kind", "receipt").not("status", "in", "(rejected,cancelled)"))).map((i) => i.pos_order_id));
  const keepPos = posIds.filter((id) => {
    const d = posDoc(id);
    if (!d && parPos.has(id)) return false;
    return d ? inMonth(d.date) : posInMonth.has(id);
  });
  // Korekty faktur: osobna linia z różnicą (nie pozycje po korekcie).
  const { data: corr } = await db.from("invoices").select("id, number, issue_date, total_gross, correction").eq("kind", "correction")
    .gte("issue_date", fromDay).lt("issue_date", toDay).in("status", KSEF_SENT).limit(2000);
  const corrIds = new Set((corr ?? []).map((c) => c.id as string));
  const manual = invoicesM.filter((i) => !i.order_id && !i.pos_order_id && !corrIds.has(i.id)).map((i) => i.id);
  const correctionLines: JpkLine[] = (corr ?? []).map((c) => {
    const k = (c.correction ?? {}) as { reason?: string; original_number?: string };
    return {
      key: `k:${c.id}`, source: "shop", kind: "invoice", docNumber: c.number as string, docDate: invoiceInstant(c.issue_date as string), saleDate: invoiceInstant(c.issue_date as string),
      name: `Korekta do ${k.original_number ?? "faktury"}${k.reason ? `: ${k.reason}` : ""}`, price: Number(c.total_gross), vat: "", unitId: null, unitCode: null,
      contractId: null, contractNumber: null, contractDate: null, purchasePrice: null, currency: null, contractStage: null, consignorWait: false,
      orderLabel: c.number as string, orderHref: `/sprzedaz/faktury/${c.id}`, saleNote: "KOREKTA",
      saleId: null, variantLinked: false, baseOrderId: null, pieceRef: null, pendingContractId: null,
    };
  });

  const lines = [
    ...(await shopLines(db, keepOrders, orderDoc)),
    ...(await posLines(db, keepPos, posDoc)),
    ...(await manualInvoiceLines(db, manual)),
    ...correctionLines,
    ...orphanReceiptLines(await orphanReceipts(db, { from, to })),
  ];
  // JPK = tylko sprzedaże z dokumentem: faktury w KSeF, paragony fiskalne (kasa i zamówienia). „Bez dokumentu” to
  // osobny podgląd sprzedaży, do których trzeba jeszcze wystawić paragon / fakturę – nie wchodzą do JPK.
  const filtered = opts.kind === "all" ? lines.filter((l) => !!l.kind) : opts.kind === "none" ? lines.filter((l) => !l.kind) : lines.filter((l) => l.kind === opts.kind);
  return sortLines(filtered);
}

/** Linie po kluczach (eksport zaznaczonych). */
export async function loadJpkLinesByKeys(db: SupabaseClient, keys: string[]) {
  const orderIds = [...new Set(keys.filter((k) => k.startsWith("o:")).map((k) => k.split(":")[1]))];
  const posItemIds = keys.filter((k) => k.startsWith("p:")).map((k) => k.slice(2));
  const invItemIds = keys.filter((k) => k.startsWith("i:")).map((k) => k.slice(2));
  const receiptIds = [...new Set(keys.filter((k) => k.startsWith("r:")).map((k) => k.split(":")[1]).filter((x) => /^[0-9a-f-]{36}$/.test(x)))];
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
    ...(receiptIds.length ? orphanReceiptLines(await orphanReceipts(db, { ids: receiptIds })) : []),
  ].filter((l) => want.has(l.key));
  return sortLines(lines);
}
