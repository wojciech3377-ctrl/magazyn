import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { draftFromOrder, type PaymentMethod } from "@/lib/invoices/service";
import type { LineItem } from "@/lib/sync/shop-orders";
import { receiptName } from "@/lib/fiscal/name";

/**
 * Paragony fiskalne z naszej drukarki: aplikacja odkłada paragon do kolejki (receipt_jobs),
 * program na komputerze przy drukarce pobiera go przez /api/drukarka, drukuje i odsyła numer.
 */

export type FiscalLine = { name: string; qty: number; price: number; ptu: string; rate: number };
export const PTU_LETTERS = ["A", "B", "C", "D", "E", "F"] as const;
export type FiscalSettings = { rates: Record<string, string>; ptu23: string; ptuMargin: string; ptuService: string };
/** Stawki zaprogramowane w drukarce (typowo A 23%, B 8%, C 5%, D 0%, E zw.); F – tu: towar w procedurze marży. */
export const FISCAL_DEFAULTS: FiscalSettings = { rates: { A: "23", B: "8", C: "5", D: "0", E: "zw", F: "0" }, ptu23: "A", ptuMargin: "F", ptuService: "A" };

export const JOB_STATUS: Record<string, { text: string; tone: "slate" | "amber" | "green" | "red" | "blue" }> = {
  queued: { text: "w kolejce do drukarki", tone: "blue" },
  printing: { text: "drukuje się…", tone: "amber" },
  printed: { text: "wydrukowany", tone: "green" },
  error: { text: "błąd wydruku", tone: "red" },
  cancelled: { text: "anulowany", tone: "slate" },
};

export async function getFiscalSettings(db: SupabaseClient): Promise<FiscalSettings> {
  const { data } = await db.from("app_settings").select("value").eq("key", "fiscal").maybeSingle();
  const v = (data?.value ?? {}) as Partial<FiscalSettings>;
  const letter = (x: unknown, d: string) => (typeof x === "string" && /^[A-G]$/.test(x) ? x : d);
  const rates = { ...FISCAL_DEFAULTS.rates, ...Object.fromEntries(Object.entries(v.rates ?? {}).filter(([k, r]) => /^[A-G]$/.test(k) && typeof r === "string" && /^(zw|\d{1,2}(,\d)?)$/.test(r))) };
  return { rates, ptu23: letter(v.ptu23, FISCAL_DEFAULTS.ptu23), ptuMargin: letter(v.ptuMargin, FISCAL_DEFAULTS.ptuMargin), ptuService: letter(v.ptuService, FISCAL_DEFAULTS.ptuService) };
}

/** „A – 23%”, „E – zw.” */
export function ptuLabel(s: FiscalSettings, letter: string) {
  const r = s.rates[letter];
  if (letter === s.ptuMargin) return `${letter} – VAT marża`;
  return r === undefined ? letter : `${letter} – ${r === "zw" ? "zw." : `${r}%`}`;
}

/** Procent stawki do zapisu paragonu (zw. = 0). */
export function rateOf(s: FiscalSettings, letter: string) {
  const r = s.rates[letter];
  return r && r !== "zw" ? Number(r.replace(",", ".")) : 0;
}

/** Czy jest aktywna drukarka (program przy drukarce fiskalnej). */
export async function fiscalPrinterReady(db: SupabaseClient) {
  const { count, error } = await db.from("fiscal_printers").select("id", { count: "exact", head: true }).eq("active", true);
  return !error && (count ?? 0) > 0;
}

/** Nazwa towaru na paragonie: bez znaków sterujących, do 40 znaków (limit drukarek). */
export function fiscalName(s: string) {
  const t = s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (t.length <= 40) return t || "Towar";
  // Za długa nazwa: rozmiar / wariant z końca zostaje (np. „… 44.5”, „… 2/3”, „… XL”, „… 128GB”), skracany jest model.
  const m = t.match(/\s((?:EU\s?)?\d{1,2}(?:[.,]\d)?(?:\s?\d\/\d)?|[2-5]?X?[SML]|XXL|\d+\s?(?:GB|TB))$/i);
  return m ? receiptName(t.slice(0, m.index), m[1]) : t.slice(0, 40).trim();
}

const round = (n: number) => Math.round(n * 100) / 100;
const PAYMENT: Record<string, PaymentMethod> = { cash: "cash", card: "card", blik: "mobile", transfer: "transfer", other: "cash", mobile: "mobile" };

async function insertJob(db: SupabaseClient, row: { source: "pos" | "order"; pos_order_id?: string; order_id?: string; lines: FiscalLine[]; payment: string; created_by: string }) {
  const total = round(row.lines.reduce((s, l) => s + l.qty * l.price, 0));
  if (!row.lines.length || total <= 0) throw new Error("Paragon nie ma pozycji do wydruku.");
  const { data, error } = await db.from("receipt_jobs").insert({ ...row, total }).select("id, number, status").single();
  if (error) {
    if (error.code === "23505") throw new Error("Do tej sprzedaży paragon jest już w kolejce albo wydrukowany.");
    throw error;
  }
  return data as { id: string; number: number; status: string };
}

/** Pozycje paragonu do sprzedaży w Kasie: sztuki z magazynu (23% albo marża) i pozycje spoza magazynu z wybraną stawką. */
export async function posReceiptLines(db: SupabaseClient, posOrderId: string) {
  const { data: o } = await db.from("pos_orders").select("id, payment_method").eq("id", posOrderId).maybeSingle();
  if (!o) throw new Error("Nie ma takiej sprzedaży.");
  const { data: items, error } = await db.from("pos_order_items")
    .select("price, status, name, ptu, quantity, unit:units(purchase_form, variant:variants(option, product:products(title)))").eq("order_id", posOrderId);
  if (error) throw error;
  const s = await getFiscalSettings(db);
  type It = { price: number; status: string; name: string | null; ptu: string | null; quantity: number | null; unit: { purchase_form: string; variant: { option: string; product: { title: string } } | null } | null };
  const lines = ((items ?? []) as unknown as It[]).filter((i) => i.status !== "returned").map((i): FiscalLine => {
    // Stawka wybrana przy pozycji w Kasie; bez wyboru: sztuka wg formy sprzedaży (23% → A, marża → F).
    const ptu = i.ptu && /^[A-G]$/.test(i.ptu) ? i.ptu : i.unit ? (i.unit.purchase_form === "vat_23" ? s.ptu23 : s.ptuMargin) : s.ptuMargin;
    // Nazwa zmieniona w Kasie ma pierwszeństwo; sztuka bez zmiany: model + rozmiar (rozmiar zawsze widoczny).
    const name = i.name?.trim() ? i.name : i.unit?.variant ? receiptName(i.unit.variant.product.title, i.unit.variant.option) : "Towar";
    return { name: fiscalName(name), qty: Number(i.quantity ?? 1), price: round(Number(i.price)), ptu, rate: rateOf(s, ptu) };
  });
  return { lines, payment: PAYMENT[o.payment_method as string] ?? "cash" };
}

/** Paragon do sprzedaży w Kasie – do kolejki drukarki. */
export async function enqueuePosReceipt(db: SupabaseClient, posOrderId: string, userId: string) {
  const { lines, payment } = await posReceiptLines(db, posOrderId);
  return insertJob(db, { source: "pos", pos_order_id: posOrderId, lines, payment, created_by: userId });
}

/**
 * Pozycje paragonu do zamówienia ze sklepu: towary (marża / 23% wg sztuki), pozycje spoza magazynu (np. sznurówki rope –
 * stawka z reguły wykluczenia), wysyłka. Zawsze z bieżących danych i ustawień (także przy „Ponów”).
 */
export async function orderReceiptLines(db: SupabaseClient, orderId: string) {
  const d = await draftFromOrder(db, orderId);
  if (!d) throw new Error("Nie ma takiego zamówienia.");
  const s = await getFiscalSettings(db);
  const lines: FiscalLine[] = d.items.map((i) => {
    const ptu = i.unit === "usł." ? s.ptuService : i.excluded ? (i.vat === "23" ? s.ptuService : s.ptuMargin) : i.vat === "23" ? s.ptu23 : s.ptuMargin;
    return { name: fiscalName(i.name), qty: i.quantity, price: round(i.unit_price_gross), ptu, rate: rateOf(s, ptu) };
  });
  return { lines, payment: d.paymentMethod };
}

/** Paragon do zamówienia ze sklepu – do kolejki drukarki. */
export async function enqueueOrderReceipt(db: SupabaseClient, orderId: string, userId: string) {
  const { data: o } = await db.from("orders").select("id, cancelled_at, receipt_id").eq("id", orderId).maybeSingle();
  if (!o) throw new Error("Nie ma takiego zamówienia.");
  if (o.cancelled_at) throw new Error("Zamówienie jest anulowane.");
  if (o.receipt_id) throw new Error(`Paragon do tego zamówienia już jest (nr ${o.receipt_id}).`);
  const { lines, payment } = await orderReceiptLines(db, orderId);
  return insertJob(db, { source: "order", order_id: orderId, lines, payment, created_by: userId });
}

/** Nowy klucz programu drukarki: zwracany raz (do wpisania w programie), w bazie tylko skrót. */
export function newPrinterToken() {
  const token = `drk_${randomBytes(24).toString("base64url")}`;
  return { token, hash: hashToken(token) };
}
export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

/** Drukarka po kluczu z nagłówka Authorization: Bearer … (program na komputerze przy drukarce). */
export async function printerFromRequest(db: SupabaseClient, req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const { data } = /^drk_[A-Za-z0-9_-]{20,200}$/.test(token)
    ? await db.from("fiscal_printers").select("id, name, active").eq("token_hash", hashToken(token)).maybeSingle()
    : { data: null };
  if (data?.active) return data as { id: string; name: string; active: boolean };
  // Zły klucz: zapis w dzienniku bezpieczeństwa (najwyżej kilka wpisów na godzinę z jednego adresu).
  const { ipFrom, rateLimit, securityEvent } = await import("@/lib/security");
  if (await rateLimit(`printer-bad-log:${ipFrom(req.headers)}`, 5, 3600)) {
    await securityEvent("printer_bad_key", data ? `nieaktywna: ${data.name}` : null, { path: new URL(req.url).pathname }, req.headers);
  }
  return null;
}
