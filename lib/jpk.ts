import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LineItem } from "@/lib/sync/shop-orders";

/**
 * Linie do JPK: każda sprzedana sztuka (sklep + sprzedaż stacjonarna, później faktury) z dokumentem
 * sprzedaży (paragon / faktura) i danymi zakupu z umowy przypiętej do sztuki.
 */

export type DocKind = "receipt" | "invoice";

export type JpkLine = {
  key: string;                 // s:<sale id> | p:<pos item id>
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
  saleNote: string | null;     // np. ZWROT, NIE ODEBRANE POBRANIE
};

type UnitRow = {
  id: string; code: string; owner_type: string; purchase_form: string; purchase_price: number | null; payout_amount: number | null;
  contract: { id: string; number: number | null; doc_number: string | null; contract_date: string | null; currency: string | null; template: string | null } | null;
} | null;

const UNIT_FIELDS = "id, code, owner_type, purchase_form, purchase_price, payout_amount, contract:contracts(id, number, doc_number, contract_date, currency, template)";

export function contractLabel(c: { number: number | null; doc_number: string | null; template: string | null } | null) {
  if (!c) return null;
  if (c.doc_number) return c.doc_number;
  return c.template && c.number ? String(c.number) : null;
}

function vatOf(unit: UnitRow, taxRate?: number | null): JpkLine["vat"] {
  if (unit) return unit.purchase_form === "vat_23" ? "A" : "F";
  if (taxRate === 23) return "A";
  if (taxRate !== undefined && taxRate !== null) return "F";
  return "";
}

function unitPart(u: UnitRow) {
  return {
    unitId: u?.id ?? null,
    unitCode: u?.code ?? null,
    contractId: u?.contract?.id ?? null,
    contractNumber: contractLabel(u?.contract ?? null),
    contractDate: u?.contract?.contract_date ?? null,
    purchasePrice: u ? Number((u.owner_type === "consignment" ? u.payout_amount : u.purchase_price) ?? NaN) || null : null,
    currency: u?.contract?.currency ?? null,
  };
}

async function chunked<T>(ids: (string | number)[], fn: (part: (string | number)[]) => PromiseLike<{ data: T[] | null; error: unknown }>) {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await fn(ids.slice(i, i + 200));
    if (error) throw error;
    out.push(...(data ?? []));
  }
  return out;
}

type ReceiptRow = { id: string; number: string | null; issued_at: string; base_order_id: number | null; pos_order_id: string | null; items: { name: string; price_brutto: number; tax_rate: number; sku?: string }[] };

/** Linie z dokumentem z zakresu dat (paragony; faktury dojdą z modułem faktur) albo bez dokumentu. */
export async function loadJpkLines(db: SupabaseClient, opts: { from: Date; to: Date; kind: "all" | DocKind | "none" }): Promise<JpkLine[]> {
  if (opts.kind === "invoice") return [];
  if (opts.kind === "none") return loadWithoutDocument(db, opts.from, opts.to);

  const { data: receipts, error } = await db.from("receipts").select("id, number, issued_at, base_order_id, pos_order_id, items")
    .gte("issued_at", opts.from.toISOString()).lt("issued_at", opts.to.toISOString()).order("issued_at").limit(5000);
  if (error) throw error;
  const recs = (receipts ?? []) as ReceiptRow[];
  const byBase = new Map<number, ReceiptRow>();
  const byPos = new Map<string, ReceiptRow>();
  for (const r of recs) {
    if (r.base_order_id && !byBase.has(r.base_order_id)) byBase.set(r.base_order_id, r);
    if (r.pos_order_id && !byPos.has(r.pos_order_id)) byPos.set(r.pos_order_id, r);
  }

  const lines: JpkLine[] = [];
  lines.push(...(await shopLines(db, [...byBase.keys()], (s) => byBase.get(s))));
  lines.push(...(await posLines(db, [...byPos.keys()], (p) => byPos.get(p))));
  return sortLines(lines);
}

export function sortLines(lines: JpkLine[]) {
  return lines.sort((a, b) => (a.docDate ?? a.saleDate).localeCompare(b.docDate ?? b.saleDate) || (a.docNumber ?? "").localeCompare(b.docNumber ?? "", "pl", { numeric: true }) || a.name.localeCompare(b.name));
}

type SaleRow = {
  id: string; base_order_id: number; order_id: string | null; order_ref: string | null; product_name: string | null; price: number | null; status: string; sold_at: string; variant_id: string | null;
  variant: { option: string; product: { title: string } } | null;
  unit: UnitRow;
  shop_order: { id: string; name: string; status: string; cod: boolean; line_items: LineItem[] } | null;
};

async function shopLines(db: SupabaseClient, baseOrderIds: number[], receiptOf: (baseOrderId: number) => ReceiptRow | undefined) {
  if (!baseOrderIds.length) return [];
  const sales = await chunked<SaleRow>(baseOrderIds, (part) =>
    db.from("sales").select(`id, base_order_id, order_id, order_ref, product_name, price, status, sold_at, variant_id, variant:variants(option, product:products(title)), unit:units(${UNIT_FIELDS}), shop_order:orders(id, name, status, cod, line_items)`)
      .in("base_order_id", part as number[]).neq("status", "unmatched") as unknown as PromiseLike<{ data: SaleRow[] | null; error: unknown }>);
  const priceOf = await shopifyPrices(db, sales);
  return sales.map((s): JpkLine => {
    const r = receiptOf(s.base_order_id);
    const item = r?.items?.filter((i) => !/wysy[łl]k|dostaw|delivery|shipping|kurier/i.test(i.name));
    const name = s.variant ? `${s.variant.product.title} ${s.variant.option}` : s.product_name ?? "";
    const price = s.price ?? priceOf.get(s.id) ?? (item?.length === 1 ? Number(item[0].price_brutto) : null);
    const cancelled = s.status === "cancelled";
    return {
      key: `s:${s.id}`, source: "shop", kind: r ? "receipt" : null, docNumber: r?.number ?? null, docDate: r?.issued_at ?? null, saleDate: s.sold_at,
      name, price, vat: vatOf(s.unit, item?.length === 1 ? item[0].tax_rate : null), ...unitPart(s.unit),
      orderLabel: s.shop_order?.name ?? s.order_ref ?? `Base ${s.base_order_id}`, orderHref: s.shop_order ? `/sprzedaz/${s.shop_order.id}` : null,
      saleNote: cancelled ? (s.shop_order?.cod && s.shop_order.status === "problem" ? "NIE ODEBRANE POBRANIE" : "ZWROT") : null,
    };
  });
}

/** Cena z pozycji zamówienia Shopify dla linii bez ceny z Base (ten sam rozmiar). */
async function shopifyPrices(db: SupabaseClient, sales: SaleRow[]) {
  const out = new Map<string, number>();
  const need = sales.filter((s) => s.price === null && s.shop_order && s.variant_id);
  if (!need.length) return out;
  const gids = [...new Set(need.flatMap((s) => s.shop_order!.line_items.map((l) => l.shopify_variant_id).filter((x): x is string => !!x)))];
  const links = await chunked<{ variant_id: string; shopify_variant_id: string }>(gids, (part) =>
    db.from("variant_store_links").select("variant_id, shopify_variant_id").in("shopify_variant_id", part as string[]) as unknown as PromiseLike<{ data: { variant_id: string; shopify_variant_id: string }[] | null; error: unknown }>);
  const variantOf = new Map(links.map((l) => [l.shopify_variant_id, l.variant_id]));
  for (const s of need) {
    const line = s.shop_order!.line_items.find((l) => l.shopify_variant_id && variantOf.get(l.shopify_variant_id) === s.variant_id);
    if (line) out.set(s.id, Number(line.price));
  }
  return out;
}

type PosItemRow = {
  id: string; order_id: string; price: number; status: string;
  order: { id: string; code: string; created_at: string } | null;
  unit: (NonNullable<UnitRow> & { variant: { option: string; product: { title: string } } | null }) | null;
};

async function posLines(db: SupabaseClient, posOrderIds: string[], receiptOf: (posOrderId: string) => ReceiptRow | undefined) {
  if (!posOrderIds.length) return [];
  const items = await chunked<PosItemRow>(posOrderIds, (part) =>
    db.from("pos_order_items").select(`id, order_id, price, status, order:pos_orders(id, code, created_at), unit:units(${UNIT_FIELDS}, variant:variants(option, product:products(title)))`)
      .in("order_id", part as string[]) as unknown as PromiseLike<{ data: PosItemRow[] | null; error: unknown }>);
  return items.map((i): JpkLine => {
    const r = receiptOf(i.order_id);
    return {
      key: `p:${i.id}`, source: "pos", kind: r ? "receipt" : null, docNumber: r?.number ?? null, docDate: r?.issued_at ?? null, saleDate: i.order?.created_at ?? "",
      name: i.unit?.variant ? `${i.unit.variant.product.title} ${i.unit.variant.option}` : "",
      price: Number(i.price), vat: vatOf(i.unit), ...unitPart(i.unit),
      orderLabel: i.order?.code ?? "", orderHref: i.order ? `/kasa/${i.order.id}` : null,
      saleNote: i.status === "returned" ? "ZWROT" : null,
    };
  });
}

/** Sprzedaże z zakresu dat (wg daty sprzedaży), do których nie ma jeszcze paragonu ani faktury. */
async function loadWithoutDocument(db: SupabaseClient, from: Date, to: Date) {
  const [{ data: sales }, { data: pos }] = await Promise.all([
    db.from("sales").select("base_order_id").gte("sold_at", from.toISOString()).lt("sold_at", to.toISOString()).neq("status", "unmatched").limit(5000),
    db.from("pos_orders").select("id").gte("created_at", from.toISOString()).lt("created_at", to.toISOString()).limit(5000),
  ]);
  const baseIds = [...new Set((sales ?? []).map((s) => Number(s.base_order_id)))];
  const posIds = (pos ?? []).map((p) => p.id as string);
  const [withBase, withPos] = await Promise.all([
    chunked<{ base_order_id: number }>(baseIds, (part) => db.from("receipts").select("base_order_id").in("base_order_id", part as number[]) as unknown as PromiseLike<{ data: { base_order_id: number }[] | null; error: unknown }>),
    chunked<{ pos_order_id: string }>(posIds, (part) => db.from("receipts").select("pos_order_id").in("pos_order_id", part as string[]) as unknown as PromiseLike<{ data: { pos_order_id: string }[] | null; error: unknown }>),
  ]);
  const hasBase = new Set(withBase.map((r) => Number(r.base_order_id)));
  const hasPos = new Set(withPos.map((r) => r.pos_order_id));
  const lines = [
    ...(await shopLines(db, baseIds.filter((id) => !hasBase.has(id)), () => undefined)),
    ...(await posLines(db, posIds.filter((id) => !hasPos.has(id)), () => undefined)),
  ];
  return sortLines(lines);
}

/** Linie po kluczach (eksport zaznaczonych) – dokument z zakresu ±1 rok, żeby odnaleźć daty paragonów. */
export async function loadJpkLinesByKeys(db: SupabaseClient, keys: string[]) {
  const saleIds = keys.filter((k) => k.startsWith("s:")).map((k) => k.slice(2));
  const posIds = keys.filter((k) => k.startsWith("p:")).map((k) => k.slice(2));
  const [sales, pos] = await Promise.all([
    chunked<{ base_order_id: number }>(saleIds, (part) => db.from("sales").select("base_order_id").in("id", part as string[]) as unknown as PromiseLike<{ data: { base_order_id: number }[] | null; error: unknown }>),
    chunked<{ order_id: string }>(posIds, (part) => db.from("pos_order_items").select("order_id").in("id", part as string[]) as unknown as PromiseLike<{ data: { order_id: string }[] | null; error: unknown }>),
  ]);
  const baseIds = [...new Set(sales.map((s) => Number(s.base_order_id)))];
  const posOrderIds = [...new Set(pos.map((p) => p.order_id))];
  const [rb, rp] = await Promise.all([
    chunked<ReceiptRow>(baseIds, (part) => db.from("receipts").select("id, number, issued_at, base_order_id, pos_order_id, items").in("base_order_id", part as number[]) as unknown as PromiseLike<{ data: ReceiptRow[] | null; error: unknown }>),
    chunked<ReceiptRow>(posOrderIds, (part) => db.from("receipts").select("id, number, issued_at, base_order_id, pos_order_id, items").in("pos_order_id", part as string[]) as unknown as PromiseLike<{ data: ReceiptRow[] | null; error: unknown }>),
  ]);
  const byBase = new Map(rb.map((r) => [Number(r.base_order_id), r]));
  const byPos = new Map(rp.map((r) => [r.pos_order_id as string, r]));
  const want = new Set(keys);
  const lines = [
    ...(await shopLines(db, baseIds, (id) => byBase.get(id))),
    ...(await posLines(db, posOrderIds, (id) => byPos.get(id))),
  ].filter((l) => want.has(l.key));
  return sortLines(lines);
}
