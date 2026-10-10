import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getCompany } from "@/lib/contracts/settings";
import { errorMessage } from "@/lib/errors";
import { invoiceStatus, sendInvoice } from "@/lib/ksef/client";
import type { LineItem } from "@/lib/sync/shop-orders";
import { buildFa3, invoiceTotals, nipValid, onlyDigits, type InvoiceItemInput, type InvoiceParty } from "./xml";
import { KSEF_COUNTRIES } from "./countries";

export type PaymentMethod = "cash" | "card" | "transfer" | "mobile";
export type DraftItem = InvoiceItemInput & { unit_id?: string | null; sale_id?: string | null; pos_item_id?: string | null; checkVat?: boolean };
export type InvoiceDraft = {
  buyer: InvoiceParty;
  issueDate: string;
  saleDate: string;
  paymentMethod: PaymentMethod;
  paid: boolean;
  paidAt: string | null;
  dueDate: string | null;
  items: DraftItem[];
  orderId: string | null;
  posOrderId: string | null;
  notes: string | null;
};

export function todayPl() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw" }).format(new Date());
}

function dayPl(iso: string) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw" }).format(new Date(iso));
}

type Unit = { id: string; purchase_form: string } | null;

/** Szkic faktury do zamówienia ze sklepu: nabywca z adresu, pozycje z zamówienia (marża / 23% wg sztuki), wysyłka 23%. */
export async function draftFromOrder(db: SupabaseClient, orderId: string): Promise<InvoiceDraft | null> {
  const { data: o } = await db.from("orders").select("id, ordered_at, customer_name, email, shipping_address, shipping_method, shipping_price, financial_status, cod, payment_gateways, line_items").eq("id", orderId).maybeSingle();
  if (!o) return null;
  const { data: sales } = await db.from("sales").select("id, variant_id, status, unit:units(id, purchase_form)").eq("order_id", orderId);
  const lines = (o.line_items ?? []) as LineItem[];
  const gids = lines.map((l) => l.shopify_variant_id).filter((x): x is string => !!x);
  const { data: links } = gids.length ? await db.from("variant_store_links").select("variant_id, shopify_variant_id").in("shopify_variant_id", gids) : { data: [] };
  const variantOf = new Map((links ?? []).map((l) => [l.shopify_variant_id as string, l.variant_id as string]));
  const pool = [...(sales ?? [])].filter((s) => s.status !== "cancelled") as unknown as { id: string; variant_id: string | null; unit: Unit }[];
  const items: DraftItem[] = [];
  for (const l of lines) {
    if (l.service) continue;
    const variantId = l.shopify_variant_id ? variantOf.get(l.shopify_variant_id) : undefined;
    for (let n = 0; n < Math.max(1, l.quantity); n++) {
      const idx = pool.findIndex((s) => variantId && s.variant_id === variantId);
      const sale = idx >= 0 ? pool.splice(idx, 1)[0] : null;
      items.push({
        name: [l.title, l.variant_title].filter(Boolean).join(" "), quantity: 1, unit: "szt.", unit_price_gross: Number(l.price), total_gross: Number(l.price),
        vat: sale?.unit?.purchase_form === "vat_23" ? "23" : "margin", unit_id: sale?.unit?.id ?? null, sale_id: sale?.id ?? null,
        // Bez sztuki z magazynu nie wiadomo, czy to towar używany (marża) – do potwierdzenia w formularzu.
        checkVat: !sale?.unit,
      });
    }
  }
  if (Number(o.shipping_price) > 0) {
    items.push({ name: `Wysyłka${o.shipping_method ? ` – ${o.shipping_method}` : ""}`, quantity: 1, unit: "usł.", unit_price_gross: Number(o.shipping_price), total_gross: Number(o.shipping_price), vat: "23" });
  }
  const a = o.shipping_address as { name?: string; company?: string; address1?: string; address2?: string; zip?: string; city?: string; countryCodeV2?: string } | null;
  const paid = ["PAID", "PARTIALLY_REFUNDED"].includes(String(o.financial_status ?? "").toUpperCase());
  return {
    buyer: {
      name: a?.company || a?.name || o.customer_name || "",
      nip: null,
      address1: [a?.address1, a?.address2].filter(Boolean).join(" ") || null,
      address2: [a?.zip, a?.city].filter(Boolean).join(" ") || null,
      country: a?.countryCodeV2 ?? "PL",
      email: o.email ?? null,
      company: !!a?.company,
    },
    issueDate: todayPl(),
    saleDate: dayPl(o.ordered_at),
    paymentMethod: o.cod ? "cash" : (o.payment_gateways ?? []).some((g: string) => /shopify_payments|card|karta|stripe|przelewy24|p24|payu/i.test(g)) ? "card" : "transfer",
    paid,
    paidAt: paid ? dayPl(o.ordered_at) : null,
    dueDate: paid ? null : todayPl(),
    items,
    orderId,
    posOrderId: null,
    notes: null,
  };
}

const POS_PAYMENT: Record<string, PaymentMethod> = { cash: "cash", card: "card", blik: "mobile", transfer: "transfer", other: "cash" };

/** Szkic faktury do sprzedaży stacjonarnej. */
export async function draftFromPos(db: SupabaseClient, posOrderId: string): Promise<InvoiceDraft | null> {
  const { data: o } = await db.from("pos_orders").select("id, created_at, payment_method, customer").eq("id", posOrderId).maybeSingle();
  if (!o) return null;
  const { data: items } = await db.from("pos_order_items").select("id, price, status, unit:units(id, purchase_form, variant:variants(option, product:products(title)))").eq("order_id", posOrderId);
  return {
    buyer: { name: o.customer ?? "", nip: null, address1: null, address2: null, country: "PL", email: null, company: false },
    issueDate: todayPl(),
    saleDate: dayPl(o.created_at),
    paymentMethod: POS_PAYMENT[o.payment_method] ?? "cash",
    paid: true,
    paidAt: dayPl(o.created_at),
    dueDate: null,
    items: (items ?? []).filter((i) => i.status !== "returned").map((i) => {
      const u = i.unit as unknown as { id: string; purchase_form: string; variant: { option: string; product: { title: string } } | null } | null;
      return {
        name: u?.variant ? `${u.variant.product.title} ${u.variant.option}` : "Towar", quantity: 1, unit: "szt.",
        unit_price_gross: Number(i.price), total_gross: Number(i.price), vat: u?.purchase_form === "vat_23" ? "23" : "margin",
        unit_id: u?.id ?? null, pos_item_id: i.id,
      } satisfies DraftItem;
    }),
    orderId: null,
    posOrderId,
    notes: null,
  };
}

/** Sprawdzenie danych PRZED nadaniem numeru (numer bez dziur, a KSeF odrzuca błędne dane). */
function validate(company: Awaited<ReturnType<typeof getCompany>>, d: InvoiceDraft) {
  const sellerNip = onlyDigits(company.nip);
  if (!company.name || !company.street || !company.city) throw new Error("Uzupełnij nazwę i adres firmy w Ustawieniach (Umowy i dane firmy).");
  if (!nipValid(sellerNip)) throw new Error("NIP firmy w Ustawieniach jest nieprawidłowy.");
  if ((company.bank_account ?? "").replace(/\s/g, "").length < 10) throw new Error("Uzupełnij numer konta bankowego w Ustawieniach → Firma – jest na każdej fakturze.");
  const ksefNip = onlyDigits(process.env.KSEF_NIP);
  if (ksefNip && ksefNip !== sellerNip) throw new Error(`NIP firmy w Ustawieniach (${sellerNip}) różni się od NIP-u KSeF (${ksefNip}).`);
  const country = (d.buyer.country || "PL").toUpperCase();
  if (!KSEF_COUNTRIES.has(country)) throw new Error(`Nieznany kod kraju nabywcy: ${country} (np. PL, DE, GR – nie EL/UK).`);
  const nip = onlyDigits(d.buyer.nip);
  if (d.buyer.company && country === "PL" && !nipValid(nip)) throw new Error("Nieprawidłowy NIP nabywcy.");
  if (!d.buyer.name.trim()) throw new Error("Podaj nabywcę.");
  if (d.issueDate > todayPl()) throw new Error("Data wystawienia nie może być z przyszłości.");
  if (d.saleDate > todayPl()) throw new Error("Data sprzedaży nie może być z przyszłości.");
  if (!d.items.length || d.items.some((i) => !i.name.trim() || !(i.unit_price_gross > 0) || !(i.quantity > 0))) throw new Error("Każda pozycja musi mieć nazwę, ilość i cenę.");
}

/** Wystawienie faktury: numer FVM/n/rok, XML FA(3) i skrót do KSeF. */
export async function issueInvoice(db: SupabaseClient, d: InvoiceDraft, userId: string) {
  const company = await getCompany(db);
  d = { ...d, items: d.items.map((i) => {
    const quantity = Math.round(i.quantity * 1000) / 1000;
    const unit_price_gross = Math.round(i.unit_price_gross * 100) / 100;
    return { ...i, name: i.name.trim().slice(0, 256), quantity, unit_price_gross, total_gross: Math.round(unit_price_gross * quantity * 100) / 100 };
  }) };
  validate(company, d);
  d = { ...d, items: d.items.map(({ checkVat: _c, ...i }) => i) };
  const seller = { name: company.name, nip: onlyDigits(company.nip), address1: company.street, address2: company.city, country: "PL", email: company.email, bank_account: company.bank_account ?? null };
  const t = invoiceTotals(d.items);
  const { data, error } = await db.rpc("create_invoice", {
    p_invoice: {
      issue_date: d.issueDate, sale_date: d.saleDate, place: company.city.replace(/^\d{2}-\d{3}\s*/, "") || null, seller, buyer: d.buyer,
      currency: "PLN", payment_method: d.paymentMethod, paid: d.paid, paid_at: d.paid ? d.paidAt ?? d.issueDate : null, due_date: d.paid ? null : d.dueDate,
      total_gross: t.total, net_23: t.net23, vat_23: t.vat23, margin_total: t.margin, notes: d.notes, order_id: d.orderId, pos_order_id: d.posOrderId, created_by: userId,
    },
    p_items: d.items,
  });
  if (error) throw error;
  const row = (data as { id: string; number: string }[])[0];
  const xml = buildFa3({
    number: row.number, issueDate: d.issueDate, saleDate: d.saleDate, place: company.city.replace(/^\d{2}-\d{3}\s*/, "") || null,
    seller, buyer: d.buyer, currency: "PLN", paymentMethod: d.paymentMethod, paid: d.paid, paidAt: d.paid ? d.paidAt ?? d.issueDate : null,
    dueDate: d.paid ? null : d.dueDate, bankAccount: seller.bank_account, items: d.items, createdAt: new Date(),
  });
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(Buffer.from(xml, "utf8")).digest("base64");
  const { error: e2 } = await db.from("invoices").update({ xml, xml_hash: hash }).eq("id", row.id);
  if (e2) throw e2;
  return row;
}

/** Kody odrzucenia, przy których ta sama faktura może być wysłana ponownie (błąd po stronie KSeF / chwilowy). */
export const KSEF_TRANSIENT = new Set([405, 500, 550]);

/**
 * Wysyłka do KSeF i krótkie czekanie na numer KSeF (resztę dokończy zadanie cykliczne).
 * Blokada: tylko faktura „nie wysłana” albo odrzucona z powodu chwilowego może zostać wysłana – nigdy dwa razy naraz.
 */
export async function sendInvoiceToKsef(db: SupabaseClient, invoiceId: string) {
  const { data: inv } = await db.from("invoices").select("id, xml, status, ksef_number, ksef_status_code, order_id, pos_order_id").eq("id", invoiceId).maybeSingle();
  if (!inv?.xml) throw new Error("Brak XML faktury.");
  if (inv.ksef_number || inv.status === "accepted") return { status: "accepted" as const, ksefNumber: inv.ksef_number as string };
  if (inv.status === "cancelled") throw new Error("Faktura jest unieważniona.");
  if (inv.status === "rejected" && inv.ksef_status_code && !KSEF_TRANSIENT.has(inv.ksef_status_code)) {
    throw new Error("KSeF odrzucił tę fakturę z powodu danych – unieważnij ją i wystaw nową.");
  }
  if (inv.order_id || inv.pos_order_id) {
    const q = db.from("invoices").select("number").neq("id", inv.id).not("status", "in", "(rejected,cancelled)");
    const { data: other } = await (inv.order_id ? q.eq("order_id", inv.order_id) : q.eq("pos_order_id", inv.pos_order_id)).limit(1).maybeSingle();
    if (other) throw new Error(`Do tej sprzedaży jest już ważna faktura ${other.number}.`);
  }
  const prev = inv.status as string;
  const { data: locked, error: lockErr } = await db.from("invoices")
    .update({ status: "sending", ksef_sent_at: new Date().toISOString(), ksef_status: "wysyłanie…", ksef_status_code: null, ksef_session_ref: null, ksef_invoice_ref: null })
    .eq("id", invoiceId).in("status", ["issued", "rejected"]).select("id");
  if (lockErr) throw lockErr;
  if (!locked?.length) throw new Error("Faktura jest właśnie wysyłana.");

  let r: Awaited<ReturnType<typeof sendInvoice>>;
  try {
    r = await sendInvoice(db, inv.xml);
  } catch (e) {
    await db.from("invoices").update({ status: prev, ksef_status: `Wysyłka nie udała się: ${errorMessage(e)}` }).eq("id", invoiceId);
    throw e;
  }
  const { error: upErr } = await db.from("invoices").update({
    ksef_session_ref: r.sessionRef, ksef_invoice_ref: r.invoiceRef, ksef_status_code: 100, ksef_status: "wysłana, czeka na przetworzenie",
  }).eq("id", invoiceId);
  if (upErr) throw upErr;
  for (let i = 0; i < 6; i++) {
    await new Promise((res) => setTimeout(res, 2000));
    try {
      const st = await refreshKsefStatus(db, invoiceId);
      if (st && st.status !== "sending") return st;
    } catch {
      // status dopyta zadanie cykliczne
    }
  }
  return { status: "sending" as const, ksefNumber: null };
}

export async function refreshKsefStatus(db: SupabaseClient, invoiceId: string) {
  const { data: inv } = await db.from("invoices").select("id, status, ksef_session_ref, ksef_invoice_ref").eq("id", invoiceId).maybeSingle();
  if (!inv?.ksef_session_ref || !inv.ksef_invoice_ref || inv.status !== "sending") return null;
  const s = await invoiceStatus(db, inv.ksef_session_ref, inv.ksef_invoice_ref);
  const status = s.code === 200 && s.ksefNumber ? "accepted" : s.code === 100 || s.code === 150 || s.code === 200 ? "sending" : "rejected";
  const { error } = await db.from("invoices").update({
    status, ksef_status_code: s.code, ksef_status: s.description || null, ksef_number: status === "accepted" ? s.ksefNumber : null,
    ...(status === "accepted" ? { ksef_accepted_at: s.acquisitionDate ?? new Date().toISOString() } : {}),
  }).eq("id", invoiceId).eq("status", "sending");
  if (error) throw error;
  return { status: status as "accepted" | "sending" | "rejected", ksefNumber: status === "accepted" ? s.ksefNumber : null };
}

/** Zadanie cykliczne: statusy faktur wysłanych do KSeF. */
export async function pollKsef(db: SupabaseClient) {
  const { data } = await db.from("invoices").select("id, ksef_invoice_ref, ksef_sent_at").eq("status", "sending").limit(20);
  let done = 0;
  const errors: string[] = [];
  for (const r of data ?? []) {
    // Wysyłka przerwana przed odpowiedzią KSeF (brak numeru referencyjnego) – po 15 min wraca do „nie wysłana”.
    if (!r.ksef_invoice_ref) {
      if (r.ksef_sent_at && Date.now() - Date.parse(r.ksef_sent_at) > 15 * 60_000) {
        await db.from("invoices").update({ status: "issued", ksef_status: "Wysyłka przerwana – sprawdź w KSeF, czy faktura dotarła, zanim wyślesz ponownie." }).eq("id", r.id).eq("status", "sending");
      }
      continue;
    }
    try {
      const s = await refreshKsefStatus(db, r.id);
      if (s && s.status !== "sending") done++;
    } catch (e) {
      errors.push(errorMessage(e));
    }
  }
  if (errors.length) throw new Error(errors.slice(0, 3).join("; "));
  return { checked: data?.length ?? 0, done };
}
