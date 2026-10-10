"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin, requireProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { errorMessage } from "@/lib/errors";
import { issueInvoice, refreshKsefStatus, sendInvoiceToKsef, type DraftItem, type InvoiceDraft, type PaymentMethod } from "@/lib/invoices/service";
import { nipValid, onlyDigits } from "@/lib/invoices/xml";
import { ksefCheck, ksefConfigured } from "@/lib/ksef/client";
import { lookupNip } from "@/lib/invoices/nip-lookup";

export type InvoiceFormState = { error?: string } | null;

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Wystawienie faktury z formularza (i opcjonalnie wysyłka do KSeF). */
export async function createInvoiceAction(_: InvoiceFormState, fd: FormData): Promise<InvoiceFormState> {
  const { profile } = await requireProfile();
  const db = createAdminClient();
  let items: DraftItem[];
  try {
    items = (JSON.parse(s(fd, "items")) as DraftItem[]).map((i) => ({
      name: String(i.name ?? "").trim().slice(0, 256),
      quantity: Math.max(0.001, Number(i.quantity) || 1),
      unit: String(i.unit || "szt.").slice(0, 10),
      unit_price_gross: Math.round(Number(i.unit_price_gross) * 100) / 100,
      total_gross: Math.round(Number(i.unit_price_gross) * (Number(i.quantity) || 1) * 100) / 100,
      vat: i.vat === "23" ? "23" : "margin",
      unit_id: i.unit_id ?? null, sale_id: i.sale_id ?? null, pos_item_id: i.pos_item_id ?? null,
      checkVat: !!(i as { checkVat?: boolean }).checkVat,
    }));
  } catch {
    return { error: "Błędne pozycje faktury." };
  }
  if (!items.length) return { error: "Dodaj co najmniej jedną pozycję." };
  if (items.some((i) => !i.name || !(i.unit_price_gross > 0))) return { error: "Każda pozycja musi mieć nazwę i cenę większą od zera." };

  const company = fd.get("company") === "1";
  const country = (s(fd, "country") || "PL").toUpperCase().slice(0, 2);
  const nip = company ? (country === "PL" ? onlyDigits(s(fd, "nip")) : s(fd, "nip")) : "";
  if (company && country === "PL" && !nipValid(nip)) return { error: "Nieprawidłowy NIP nabywcy." };
  const name = s(fd, "name");
  if (!name) return { error: "Podaj nabywcę." };
  const issueDate = s(fd, "issue_date");
  const saleDate = s(fd, "sale_date") || issueDate;
  if (!isDate(issueDate) || !isDate(saleDate)) return { error: "Podaj daty wystawienia i sprzedaży." };
  const paid = fd.get("paid") === "1";
  const method = s(fd, "payment_method") as PaymentMethod;
  if (!["cash", "card", "transfer", "mobile"].includes(method)) return { error: "Wybierz formę płatności." };

  const orderId = s(fd, "order_id") || null;
  const posOrderId = s(fd, "pos_order_id") || null;
  if (orderId || posOrderId) {
    const q = db.from("invoices").select("number").not("status", "in", "(rejected,cancelled)");
    const { data: dup } = await (orderId ? q.eq("order_id", orderId) : q.eq("pos_order_id", posOrderId!)).limit(1).maybeSingle();
    if (dup) return { error: `Do tej sprzedaży jest już faktura ${dup.number}.` };
  }
  if (items.some((i) => (i as DraftItem & { checkVat?: boolean }).checkVat) && fd.get("vat_checked") !== "1") {
    return { error: "Potwierdź stawki VAT pozycji oznaczonych na pomarańczowo (brak sztuki z magazynu)." };
  }

  const draft: InvoiceDraft = {
    buyer: { name, nip: nip || null, address1: s(fd, "address1") || null, address2: s(fd, "address2") || null, country, email: s(fd, "email") || null, company },
    issueDate, saleDate, paymentMethod: method, paid,
    paidAt: paid ? (isDate(s(fd, "paid_at")) ? s(fd, "paid_at") : issueDate) : null,
    dueDate: paid ? null : (isDate(s(fd, "due_date")) ? s(fd, "due_date") : issueDate),
    items, orderId, posOrderId, notes: s(fd, "notes") || null,
  };
  let id: string;
  try {
    const row = await issueInvoice(db, draft, profile.id);
    id = row.id;
  } catch (e) {
    return { error: errorMessage(e) };
  }
  let msg = "Faktura wystawiona.";
  if (fd.get("send_ksef") === "1" && ksefConfigured()) {
    try {
      const r = await sendInvoiceToKsef(db, id);
      msg = r.status === "accepted" ? `Faktura wystawiona i przyjęta w KSeF (${r.ksefNumber}).` : r.status === "rejected" ? "Faktura wystawiona, ale KSeF ją odrzucił – szczegóły poniżej." : "Faktura wystawiona i wysłana do KSeF – numer KSeF pojawi się za chwilę.";
    } catch (e) {
      msg = `Faktura wystawiona, ale wysyłka do KSeF nie udała się: ${errorMessage(e)}`;
    }
  }
  revalidatePath("/sprzedaz");
  redirect(`/sprzedaz/faktury/${id}?ok=${encodeURIComponent(msg)}`);
}

export async function sendToKsefAction(fd: FormData) {
  await requireProfile();
  const id = s(fd, "id");
  let msg: string;
  let ok = true;
  try {
    const r = await sendInvoiceToKsef(createAdminClient(), id);
    msg = r.status === "accepted" ? `Przyjęta w KSeF (${r.ksefNumber}).` : r.status === "rejected" ? "KSeF odrzucił fakturę." : "Wysłana – numer KSeF pojawi się za chwilę.";
    ok = r.status !== "rejected";
  } catch (e) {
    msg = errorMessage(e);
    ok = false;
  }
  revalidatePath(`/sprzedaz/faktury/${id}`);
  redirect(`/sprzedaz/faktury/${id}?${ok ? "ok" : "blad"}=${encodeURIComponent(msg)}`);
}

export async function checkKsefAction(fd: FormData) {
  await requireProfile();
  const id = s(fd, "id");
  let msg = "Status sprawdzony.";
  try {
    await refreshKsefStatus(createAdminClient(), id);
  } catch (e) {
    msg = errorMessage(e);
  }
  revalidatePath(`/sprzedaz/faktury/${id}`);
  redirect(`/sprzedaz/faktury/${id}?ok=${encodeURIComponent(msg)}`);
}

/** Ustawienia: próba logowania do KSeF tokenem (bez wysyłania faktur). */
export async function testKsefAction() {
  await requireAdmin();
  let q: string;
  try {
    const r = await ksefCheck(createAdminClient());
    q = `ok=${encodeURIComponent(`Połączenie z KSeF działa (środowisko: ${r.env}).`)}`;
  } catch (e) {
    q = `blad=${encodeURIComponent(errorMessage(e))}`;
  }
  redirect(`/ustawienia?zakladka=faktury&${q}`);
}

/** Odrzucona faktura → unieważniona, żeby wystawić nową z poprawionymi danymi. */
export async function voidInvoiceAction(fd: FormData) {
  await requireAdmin();
  const id = s(fd, "id");
  const db = createAdminClient();
  const { data, error } = await db.from("invoices").update({ status: "cancelled" }).eq("id", id).eq("status", "rejected").select("order_id, pos_order_id");
  revalidatePath(`/sprzedaz/faktury/${id}`);
  if (error || !data?.length) redirect(`/sprzedaz/faktury/${id}?blad=${encodeURIComponent(error?.message ?? "Unieważnić można tylko fakturę odrzuconą przez KSeF.")}`);
  const r = data[0];
  redirect(r.order_id ? `/sprzedaz/faktury/nowa?zamowienie=${r.order_id}` : r.pos_order_id ? `/sprzedaz/faktury/nowa?kasa=${r.pos_order_id}` : "/sprzedaz/faktury/nowa");
}

export type NipLookupResult = { ok: true; name: string; address1: string; address2: string; source: string; note?: string } | { ok: false; error: string };

/** Dane nabywcy po NIP (GUS / biała lista VAT). */
export async function lookupNipAction(raw: string): Promise<NipLookupResult> {
  await requireProfile();
  const nip = onlyDigits(raw);
  if (!nipValid(nip)) return { ok: false, error: "Nieprawidłowy NIP." };
  try {
    const d = await lookupNip(nip);
    if (!d) return { ok: false, error: "Nie znaleziono firmy o tym NIP-ie." };
    return {
      ok: true, name: d.name, address1: d.address1, address2: d.address2, source: d.source === "GUS" ? "GUS" : "biała lista VAT",
      note: d.vatStatus && d.vatStatus !== "Czynny" ? `Status VAT: ${d.vatStatus}` : undefined,
    };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}
