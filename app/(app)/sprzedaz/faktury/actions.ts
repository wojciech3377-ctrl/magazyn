"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin, requireProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { errorMessage } from "@/lib/errors";
import { issueInvoice, issueReceipt, receiptPreview, refreshKsefStatus, sendInvoiceToKsef, type DraftItem, type InvoiceDraft, type PaymentMethod } from "@/lib/invoices/service";
import { nipValid, onlyDigits } from "@/lib/invoices/xml";
import { ksefCheck, ksefConfigured } from "@/lib/ksef/client";
import { lookupNip } from "@/lib/invoices/nip-lookup";
import { emailInvoice, maybeAutoEmail } from "@/lib/invoices/email";
import { findVariantIds } from "@/lib/queries/units";
import { adjustStock } from "@/lib/stock";

export type InvoiceFormState = { error?: string } | null;

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);


/** Pozycje z formularza faktury / paragonu. */
function parseItems(fd: FormData): { items: DraftItem[] } | { error: string } {
  try {
    const items = (JSON.parse(s(fd, "items")) as DraftItem[]).map((i) => ({
      name: String(i.name ?? "").trim().slice(0, 256),
      quantity: Math.max(0.001, Number(i.quantity) || 1),
      unit: String(i.unit || "szt.").slice(0, 10),
      unit_price_gross: Math.round(Number(i.unit_price_gross) * 100) / 100,
      total_gross: Math.round(Number(i.unit_price_gross) * (Number(i.quantity) || 1) * 100) / 100,
      vat: i.vat === "23" ? "23" as const : "margin" as const,
      unit_id: i.unit_id ?? null, sale_id: i.sale_id ?? null, pos_item_id: i.pos_item_id ?? null,
      checkVat: !!(i as { checkVat?: boolean }).checkVat,
    }));
    return { items };
  } catch {
    return { error: "Błędne pozycje dokumentu." };
  }
}

/** Sztuki z magazynu na dokumencie „ręcznym” (bez zamówienia i kasy) – sprzedane i zdjęte ze stanu w Shopify. */
async function sellManualUnits(db: ReturnType<typeof createAdminClient>, unitIds: string[], docId: string, userId: string, note: string) {
  if (!unitIds.length) return "";
  const { data: sold } = await db.from("units").update({ status: "sold", sold_at: new Date().toISOString() })
    .in("id", unitIds).in("status", ["in_stock", "reserved"]).select("id, variant_id, location_id");
  if (!sold?.length) return "";
  await db.from("unit_events").insert(sold.map((u) => ({ unit_id: u.id, type: "sold", data: { invoice_id: docId, note }, created_by: userId })));
  const r = await adjustStock(db, sold.map((u) => ({ variantId: u.variant_id as string, locationId: u.location_id as string, delta: -1 })));
  const failed = r.filter((x) => !x.ok);
  return failed.length ? ` Uwaga: stan w Shopify nie zmieniony (${failed.map((f) => f.message).join("; ")}) – popraw go ręcznie.` : ` Sztuki zdjęte ze stanu (${sold.length}).`;
}

async function checkManualUnits(db: ReturnType<typeof createAdminClient>, items: DraftItem[], orderId: string | null, posOrderId: string | null) {
  const ids = !orderId && !posOrderId ? [...new Set(items.map((i) => i.unit_id).filter((x): x is string => !!x))] : [];
  if (!ids.length) return { ids };
  const { data: us } = await db.from("units").select("id, code, status").in("id", ids);
  const bad = (us ?? []).filter((u) => !["in_stock", "reserved"].includes(u.status as string));
  if (bad.length || (us ?? []).length !== ids.length) return { ids, error: `Sztuka ${bad.map((u) => u.code).join(", ") || "z dokumentu"} nie jest na stanie – nie można jej sprzedać.` };
  return { ids };
}

/** Paragon z formularza: szkic bez nabywcy. */
function receiptDraft(fd: FormData, items: DraftItem[]): InvoiceDraft | { error: string } {
  if (!items.length) return { error: "Dodaj co najmniej jedną pozycję." };
  if (items.some((i) => !i.name || !(i.unit_price_gross > 0))) return { error: "Każda pozycja musi mieć nazwę i cenę większą od zera." };
  const issueDate = s(fd, "issue_date");
  const saleDate = s(fd, "sale_date") || issueDate;
  if (!isDate(issueDate) || !isDate(saleDate)) return { error: "Podaj daty wystawienia i sprzedaży." };
  const method = s(fd, "payment_method") as PaymentMethod;
  if (!["cash", "card", "transfer", "mobile"].includes(method)) return { error: "Wybierz formę płatności." };
  return {
    buyer: { name: "Osoba prywatna", nip: null, address1: null, address2: null, country: "PL", email: null, company: false },
    issueDate, saleDate, paymentMethod: method, paid: true, paidAt: isDate(s(fd, "paid_at")) ? s(fd, "paid_at") : issueDate, dueDate: null,
    items, orderId: s(fd, "order_id") || null, posOrderId: s(fd, "pos_order_id") || null, notes: s(fd, "notes") || null,
  };
}

export type ReceiptState = { error?: string; id?: string; number?: string; note?: string } | null;

/** „Podgląd dokumentu”: PDF paragonu bez nadawania numeru (base64). */
export async function previewReceiptAction(fd: FormData): Promise<{ error?: string; pdf?: string }> {
  await requireProfile();
  const db = createAdminClient();
  const parsed = parseItems(fd);
  if ("error" in parsed) return parsed;
  const d = receiptDraft(fd, parsed.items);
  if ("error" in d) return d;
  try {
    const { renderInvoicePdf } = await import("@/lib/invoices/pdf");
    const bytes = await renderInvoicePdf(await receiptPreview(db, d));
    return { pdf: Buffer.from(bytes).toString("base64") };
  } catch (e) {
    return { error: errorMessage(e) };
  }
}

/** „Wydrukuj dokument”: wystawia paragon (PAR/miesiąc/n) i zwraca jego id do wydruku. */
export async function issueReceiptAction(_: ReceiptState, fd: FormData): Promise<ReceiptState> {
  const { profile } = await requireProfile();
  const db = createAdminClient();
  const parsed = parseItems(fd);
  if ("error" in parsed) return parsed;
  const d = receiptDraft(fd, parsed.items);
  if ("error" in d) return d;
  if (d.orderId || d.posOrderId) {
    const q = db.from("invoices").select("number").eq("kind", "receipt").not("status", "in", "(rejected,cancelled)");
    const { data: dup } = await (d.orderId ? q.eq("order_id", d.orderId) : q.eq("pos_order_id", d.posOrderId!)).limit(1).maybeSingle();
    if (dup) return { error: `Do tej sprzedaży jest już paragon ${dup.number}.` };
  }
  const units = await checkManualUnits(db, d.items, d.orderId, d.posOrderId);
  if (units.error) return { error: units.error };
  let row: { id: string; number: string };
  try {
    row = await issueReceipt(db, d, profile.id);
  } catch (e) {
    return { error: errorMessage(e) };
  }
  const note = await sellManualUnits(db, units.ids, row.id, profile.id, "sprzedaż na paragon");
  revalidatePath("/sprzedaz");
  return { id: row.id, number: row.number, note };
}

/** Wystawienie faktury z formularza (i opcjonalnie wysyłka do KSeF). */
export async function createInvoiceAction(_: InvoiceFormState, fd: FormData): Promise<InvoiceFormState> {
  const { profile } = await requireProfile();
  const db = createAdminClient();
  const parsed = parseItems(fd);
  if ("error" in parsed) return parsed;
  const items = parsed.items;
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
    const q = db.from("invoices").select("number").neq("kind", "receipt").not("status", "in", "(rejected,cancelled)");
    const { data: dup } = await (orderId ? q.eq("order_id", orderId) : q.eq("pos_order_id", posOrderId!)).limit(1).maybeSingle();
    if (dup) return { error: `Do tej sprzedaży jest już faktura ${dup.number}.` };
  }
  if (items.some((i) => (i as DraftItem & { checkVat?: boolean }).checkVat) && fd.get("vat_checked") !== "1") {
    return { error: "Potwierdź stawki VAT pozycji oznaczonych na pomarańczowo (brak sztuki z magazynu)." };
  }

  // Faktura „ręczna” ze sztukami z magazynu = sprzedaż: sztuki muszą być na stanie (potem schodzą ze stanu).
  const units = await checkManualUnits(db, items, orderId, posOrderId);
  if (units.error) return { error: units.error };

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
  if (fd.get("save_customer") === "1") await saveCustomer(db, draft.buyer, profile.id);
  const shipmentId = s(fd, "consignor_shipment_id");
  if (/^[0-9a-f-]{36}$/i.test(shipmentId)) await db.from("consignor_shipments").update({ invoice_id: id }).eq("id", shipmentId).is("invoice_id", null);
  const stockNote = await sellManualUnits(db, units.ids, id, profile.id, "sprzedaż na fakturę");
  let msg = "Faktura wystawiona.";
  const toKsef = fd.get("send_ksef") === "1" && ksefConfigured();
  if (toKsef) {
    try {
      const r = await sendInvoiceToKsef(db, id);
      msg = r.status === "accepted" ? `Faktura wystawiona i przyjęta w KSeF (${r.ksefNumber}).` : r.status === "rejected" ? "Faktura wystawiona, ale KSeF ją odrzucił – szczegóły poniżej." : "Faktura wystawiona i wysłana do KSeF – numer KSeF pojawi się za chwilę.";
    } catch (e) {
      msg = `Faktura wystawiona, ale wysyłka do KSeF nie udała się: ${errorMessage(e)}`;
    }
  }
  // E-mail do nabywcy: od razu (bez KSeF) albo po przyjęciu w KSeF (także później, z zadania cyklicznego).
  const mailed = await maybeAutoEmail(db, id, { force: !toKsef });
  msg += stockNote;
  if (mailed) msg += ` Wysłana e-mailem na ${mailed}.`;
  else if (draft.buyer.email && toKsef) msg += " E-mail do nabywcy pójdzie po przyjęciu w KSeF.";
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

/** Zapis nabywcy do listy (po NIP; osoba prywatna – po nazwie i e-mailu). */
async function saveCustomer(db: ReturnType<typeof createAdminClient>, b: InvoiceDraft["buyer"], userId: string) {
  const row = { name: b.name, company: !!b.company, nip: b.nip || null, address1: b.address1, address2: b.address2, country: b.country ?? "PL", email: b.email, updated_at: new Date().toISOString() };
  // Osobne zapytania – filtry Supabase zmieniają obiekt zapytania.
  const find = () => db.from("customers").select("id");
  const { data: existing } = await (row.nip
    ? find().eq("nip", row.nip)
    : row.email ? find().is("nip", null).eq("name", row.name).eq("email", row.email) : find().is("nip", null).eq("name", row.name).is("email", null)
  ).limit(1).maybeSingle();
  if (existing) await db.from("customers").update(row).eq("id", existing.id);
  else await db.from("customers").insert({ ...row, created_by: userId });
}

export type CustomerHit = { id: string; name: string; company: boolean; nip: string | null; address1: string | null; address2: string | null; country: string; email: string | null };

/** Zapisani nabywcy: wyszukiwanie po nazwie, NIP albo e-mailu. */
export async function searchCustomersAction(q: string): Promise<CustomerHit[]> {
  const { supabase } = await requireProfile();
  const text = q.trim().replace(/[,()*%\\]/g, " ").trim();
  let query = supabase.from("customers").select("id, name, company, nip, address1, address2, country, email").order("updated_at", { ascending: false }).limit(8);
  if (text) query = query.or(`name.ilike.%${text}%,nip.ilike.%${onlyDigits(text) || text}%,email.ilike.%${text}%`);
  const { data } = await query;
  return (data ?? []) as CustomerHit[];
}

export async function deleteCustomerAction(id: string) {
  const { supabase } = await requireProfile();
  await supabase.from("customers").delete().eq("id", id);
}

/** Ręczna wysyłka faktury e-mailem (na adres nabywcy albo inny podany). */
export async function emailInvoiceAction(fd: FormData) {
  await requireProfile();
  const id = s(fd, "id");
  let q: string;
  try {
    const to = await emailInvoice(createAdminClient(), id, s(fd, "to") || null);
    q = `ok=${encodeURIComponent(`Faktura wysłana na ${to}.`)}`;
  } catch (e) {
    q = `blad=${encodeURIComponent(errorMessage(e))}`;
  }
  revalidatePath(`/sprzedaz/faktury/${id}`);
  redirect(`/sprzedaz/faktury/${id}?${q}`);
}

export type InvoiceItemHit = { key: string; name: string; detail: string; price: number | null; vat: "23" | "margin"; unit_id: string | null; checkVat: boolean };

/** Pozycje faktury z magazynu (sztuki na stanie – z formą zakupu i IMEI) albo z katalogu (rozmiar bez sztuki). */
export async function searchInvoiceItemsAction(q: string): Promise<InvoiceItemHit[]> {
  const { supabase } = await requireProfile();
  const text = q.trim().replace(/[,()*%\\]/g, " ").trim();
  if (text.length < 2) return [];
  const like = `%${text}%`;
  const variantIds = await findVariantIds(supabase, text);
  const unitOr = [`code.ilike.${like}`, `identifier.ilike.${like}`, `title.ilike.${like}`, `style_sku.ilike.${like}`];
  if (variantIds.length) unitOr.push(`variant_id.in.(${variantIds.slice(0, 150).join(",")})`);
  const { data: units } = await supabase.from("units_list")
    .select("id, code, identifier, title, option, shop_price, purchase_form, variant_id")
    .eq("status", "in_stock").or(unitOr.join(",")).order("received_at", { ascending: true }).limit(10);
  const hits: InvoiceItemHit[] = (units ?? []).map((u) => ({
    key: `u:${u.id}`,
    name: `${u.title} ${u.option}${u.identifier ? ` (IMEI/SN ${u.identifier})` : ""}`.trim(),
    detail: `sztuka ${u.code} · ${u.purchase_form === "vat_23" ? "VAT 23%" : "marża"}`,
    price: u.shop_price === null ? null : Number(u.shop_price),
    vat: u.purchase_form === "vat_23" ? "23" : "margin",
    unit_id: u.id as string,
    checkVat: false,
  }));
  const withUnits = new Set((units ?? []).map((u) => u.variant_id as string));
  const rest = variantIds.filter((v) => !withUnits.has(v)).slice(0, 8);
  if (rest.length) {
    const { data: vars } = await supabase.from("variants")
      .select("id, option, product:products(title), links:variant_store_links(price)").in("id", rest);
    for (const v of vars ?? []) {
      const p = v.product as unknown as { title: string } | null;
      const price = ((v.links ?? []) as { price: number | null }[]).find((l) => l.price !== null)?.price ?? null;
      hits.push({ key: `v:${v.id}`, name: `${p?.title ?? ""} ${v.option}`.trim(), detail: "z katalogu – bez sztuki na stanie", price: price === null ? null : Number(price), vat: "margin", unit_id: null, checkVat: true });
    }
  }
  return hits;
}

/** Ustawienia: e-mail testowy (sprawdzenie SMTP). */
export async function sendTestMailAction(fd: FormData) {
  await requireAdmin();
  const { getCompany } = await import("@/lib/contracts/settings");
  const { sendMail } = await import("@/lib/mail");
  const company = await getCompany(createAdminClient());
  const to = s(fd, "to") || company.email;
  let q: string;
  try {
    if (!to) throw new Error("Podaj adres e-mail.");
    await sendMail(to, "Test wysyłki – magazyn", `<p>Wysyłka e-maili z aplikacji działa. Faktury będą wychodzić z tego adresu automatycznie.</p>`);
    q = `ok=${encodeURIComponent(`E-mail testowy wysłany na ${to}.`)}`;
  } catch (e) {
    q = `blad=${encodeURIComponent(`SMTP: ${errorMessage(e)}`)}`;
  }
  redirect(`/ustawienia?zakladka=faktury&${q}`);
}

/**
 * Usunięcie faktury, której nie ma w KSeF (nie wysłana albo odrzucona). Faktury z KSeF nie da się usunąć –
 * tylko skorygować. Sztuki sprzedane tą fakturą (bez zamówienia i kasy) wracają na stan.
 */
export async function deleteInvoiceAction(fd: FormData) {
  await requireAdmin();
  const id = s(fd, "id");
  const db = createAdminClient();
  const { data: inv } = await db.from("invoices").select("id, number, status, ksef_number, order_id, pos_order_id").eq("id", id).maybeSingle();
  if (!inv) redirect("/sprzedaz?widok=faktury");
  if (inv.ksef_number || ["accepted", "sending"].includes(inv.status as string)) {
    redirect(`/sprzedaz/faktury/${id}?blad=${encodeURIComponent("Faktura jest w KSeF – nie można jej usunąć. Wystaw korektę.")}`);
  }
  const { data: items } = await db.from("invoice_items").select("unit_id").eq("invoice_id", id).not("unit_id", "is", null);
  const unitIds = !inv.order_id && !inv.pos_order_id ? [...new Set((items ?? []).map((i) => i.unit_id as string))] : [];
  const { error } = await db.rpc("delete_invoice", { p_id: id });
  if (error) redirect(`/sprzedaz/faktury/${id}?blad=${encodeURIComponent(error.message)}`);
  let note = "";
  if (unitIds.length) {
    const { data: back } = await db.from("units").update({ status: "in_stock", sold_at: null }).in("id", unitIds).eq("status", "sold").select("id, variant_id, location_id");
    if (back?.length) {
      await db.from("unit_events").insert(back.map((u) => ({ unit_id: u.id, type: "status", data: { to: "in_stock", note: `faktura ${inv.number} usunięta` } })));
      await adjustStock(db, back.map((u) => ({ variantId: u.variant_id as string, locationId: u.location_id as string, delta: 1 })));
      note = ` ${back.length} szt. wróciło na stan.`;
    }
  }
  revalidatePath("/sprzedaz");
  redirect(`/sprzedaz?widok=faktury&ok=${encodeURIComponent(`Faktura ${inv.number} usunięta.${note}`)}`);
}

/** Faktura korygująca do faktury przyjętej w KSeF; od razu wysyłana do KSeF (gdy jest skonfigurowany). */
export async function issueCorrectionAction(_: InvoiceFormState, fd: FormData): Promise<InvoiceFormState> {
  const { profile } = await requireProfile();
  const db = createAdminClient();
  const originalId = s(fd, "original_id");
  let items: { name: string; quantity: number; unit: string; unit_price_gross: number; vat: "23" | "margin" }[];
  try {
    items = JSON.parse(s(fd, "items") || "[]");
  } catch {
    return { error: "Błąd pozycji." };
  }
  const type = Number(s(fd, "type")) as 1 | 2 | 3;
  const issueDate = isDate(s(fd, "issue_date")) ? s(fd, "issue_date") : new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw" }).format(new Date());
  let id: string;
  try {
    const { issueCorrection } = await import("@/lib/invoices/service");
    const row = await issueCorrection(db, originalId, {
      items: items.map((i) => ({ name: String(i.name ?? ""), quantity: Number(i.quantity) || 0, unit: String(i.unit || "szt."), unit_price_gross: Number(String(i.unit_price_gross).replace(",", ".")) || 0, total_gross: 0, vat: i.vat === "23" ? "23" : "margin" })),
      reason: s(fd, "reason"), type: [1, 2, 3].includes(type) ? type : 2, issueDate,
    }, profile.id);
    id = row.id;
  } catch (e) {
    return { error: errorMessage(e) };
  }
  let msg = "Korekta wystawiona.";
  if (ksefConfigured()) {
    try {
      const r = await sendInvoiceToKsef(db, id);
      msg = r.status === "accepted" ? `Korekta przyjęta w KSeF (${r.ksefNumber}).` : r.status === "rejected" ? "Korekta wystawiona, ale KSeF ją odrzucił – szczegóły poniżej." : "Korekta wysłana do KSeF – numer pojawi się za chwilę.";
    } catch (e) {
      msg = `Korekta wystawiona, ale wysyłka do KSeF nie udała się: ${errorMessage(e)}`;
    }
  }
  revalidatePath("/sprzedaz");
  redirect(`/sprzedaz/faktury/${id}?ok=${encodeURIComponent(msg)}`);
}
