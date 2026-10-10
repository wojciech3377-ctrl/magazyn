import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mailConfigured, sendMail } from "@/lib/mail";
import { errorMessage } from "@/lib/errors";
import { renderInvoicePdf, type InvoiceForPdf } from "./pdf";

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const pln = (n: number) => new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN" }).format(n);
const day = (d: string | null) => (d ? d.split("-").reverse().join(".") : "–");

/** Faktura e-mailem z PDF w załączniku. Wynik (data / błąd) zapisany przy fakturze. */
export async function emailInvoice(db: SupabaseClient, invoiceId: string, toOverride?: string | null) {
  const { data: inv } = await db.from("invoices").select("*").eq("id", invoiceId).maybeSingle();
  if (!inv) throw new Error("Nie ma takiej faktury.");
  const buyer = inv.buyer as InvoiceForPdf["buyer"];
  const seller = inv.seller as InvoiceForPdf["seller"];
  const to = (toOverride ?? buyer.email ?? "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new Error("Brak poprawnego adresu e-mail nabywcy.");
  if (!mailConfigured()) throw new Error("Wysyłka e-maili nie jest skonfigurowana (SMTP w Vercel).");
  if (inv.status === "cancelled" || inv.status === "rejected") throw new Error("Nie wysyłamy faktury unieważnionej ani odrzuconej przez KSeF.");
  const { data: items } = await db.from("invoice_items").select("*").eq("invoice_id", invoiceId).order("position");
  try {
    const pdf = await renderInvoicePdf({ ...(inv as InvoiceForPdf), items: (items ?? []) as InvoiceForPdf["items"] });
    const due = !inv.paid && inv.due_date ? `<p style="margin:0 0 6px">Termin płatności: <b>${day(inv.due_date)}</b>${seller.bank_account ? `, konto: <b>${esc(seller.bank_account)}</b>` : ""}</p>` : "";
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#17232f;max-width:560px">
      <p style="margin:0 0 12px">Dzień dobry,</p>
      <p style="margin:0 0 12px">w załączniku przesyłamy fakturę <b>${esc(inv.number)}</b> z dnia ${day(inv.issue_date)} na kwotę <b>${pln(Number(inv.total_gross))}</b>.</p>
      ${due}
      ${inv.ksef_number ? `<p style="margin:0 0 6px;color:#5b6878;font-size:13px">Numer KSeF: ${esc(inv.ksef_number)}</p>` : ""}
      <p style="margin:16px 0 0">Pozdrawiamy<br><b>${esc(seller.name)}</b>${seller.email ? `<br><a href="mailto:${esc(seller.email)}" style="color:#3861ab">${esc(seller.email)}</a>` : ""}</p>
    </div>`;
    await sendMail(to, `Faktura ${inv.number} – ${seller.name}`, html, [{ filename: `${String(inv.number).replace(/\//g, "-")}.pdf`, content: Buffer.from(pdf) }]);
    await db.from("invoices").update({ emailed_at: new Date().toISOString(), emailed_to: to, email_error: null }).eq("id", invoiceId);
    return to;
  } catch (e) {
    await db.from("invoices").update({ email_error: errorMessage(e) }).eq("id", invoiceId);
    throw e;
  }
}

export async function invoiceAutoEmail(db: SupabaseClient) {
  const { data } = await db.from("app_settings").select("value").eq("key", "invoices").maybeSingle();
  return (data?.value as { auto_email?: boolean } | null)?.auto_email !== false;
}

/**
 * Automatyczna wysyłka: raz, gdy faktura jest gotowa (przyjęta w KSeF albo – bez KSeF – zaraz po wystawieniu),
 * a nabywca podał e-mail. Błędy tylko zapisuje (widać je na stronie faktury).
 */
export async function maybeAutoEmail(db: SupabaseClient, invoiceId: string, opts: { force?: boolean } = {}) {
  if (!mailConfigured() || !(await invoiceAutoEmail(db))) return null;
  const { data: inv } = await db.from("invoices").select("id, status, emailed_at, buyer").eq("id", invoiceId).maybeSingle();
  if (!inv || inv.emailed_at || !(inv.buyer as { email?: string | null }).email) return null;
  if (!(inv.status === "accepted" || (opts.force && inv.status === "issued"))) return null;
  // Blokada przed podwójną wysyłką (zadanie cykliczne i użytkownik jednocześnie).
  const { data: claimed } = await db.from("invoices").update({ emailed_at: new Date().toISOString() }).eq("id", invoiceId).is("emailed_at", null).select("id");
  if (!claimed?.length) return null;
  try {
    return await emailInvoice(db, invoiceId);
  } catch {
    await db.from("invoices").update({ emailed_at: null }).eq("id", invoiceId);
    return null;
  }
}
