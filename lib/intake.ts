import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mailConfigured, sendMail } from "@/lib/mail";
import { getCompany } from "@/lib/contracts/settings";

/**
 * Zgłoszenia rzeczy od komisantów: komisant proponuje rzeczy i swoje kwoty → sklep: Tak / Nie / Oferta →
 * komisant odpowiada na oferty → paczka do wysłania (komisant dodaje tracking) → przyjęcie w Przyjęciu dostawy.
 */

export type IntakeStatus = "review" | "offer" | "to_send" | "sent" | "received" | "closed" | "cancelled";
export type IntakeItemStatus = "proposed" | "offered" | "accepted" | "rejected" | "declined" | "received" | "missing";

export type IntakeItem = {
  id: string; intake_id: string; position: number; variant_id: string | null; title: string; option: string | null;
  proposed_price: number; offer_price: number | null; final_price: number | null; status: IntakeItemStatus; unit_id: string | null;
  purchase_form: "vat_margin" | "vat_23";
};

export const PURCHASE_FORM_SHORT: Record<string, string> = { vat_margin: "VAT marża", vat_23: "VAT 23%" };
export type Intake = {
  id: string; consignor_id: string; location_id: string; status: IntakeStatus; note: string | null; tracking: string | null; carrier: string | null;
  delivery_id: string | null; created_at: string; decided_at: string | null; sent_at: string | null; received_at: string | null;
};

export const INTAKE_STATUS: Record<IntakeStatus, { text: string; tone: "amber" | "blue" | "green" | "slate" | "red" }> = {
  review: { text: "czeka na naszą decyzję", tone: "amber" },
  offer: { text: "nasza oferta – czeka na odpowiedź komisanta", tone: "blue" },
  to_send: { text: "do wysłania – brak numeru przesyłki", tone: "amber" },
  sent: { text: "wysłana do nas", tone: "blue" },
  received: { text: "przyjęta", tone: "green" },
  closed: { text: "zamknięta (nic nie przyjęte)", tone: "slate" },
  cancelled: { text: "anulowana", tone: "slate" },
};

export const ITEM_STATUS: Record<IntakeItemStatus, string> = {
  proposed: "czeka na decyzję",
  offered: "nasza oferta",
  accepted: "przyjęte – do wysłania",
  rejected: "odrzucone",
  declined: "oferta odrzucona",
  received: "dotarło",
  missing: "nie dotarło",
};

/** Status zgłoszenia z pozycji (po decyzjach sklepu albo odpowiedzi komisanta). Nie cofa paczek już wysłanych. */
export async function refreshIntakeStatus(db: SupabaseClient, intakeId: string) {
  const { data: intake } = await db.from("consignor_intakes").select("status").eq("id", intakeId).maybeSingle();
  if (!intake || !["review", "offer", "to_send"].includes(intake.status as string)) return intake?.status as IntakeStatus | undefined;
  const { data: items } = await db.from("consignor_intake_items").select("status").eq("intake_id", intakeId);
  const st = (items ?? []).map((i) => i.status as IntakeItemStatus);
  const next: IntakeStatus = st.includes("proposed") ? "review" : st.includes("offered") ? "offer" : st.includes("accepted") ? "to_send" : "closed";
  if (next !== intake.status) await db.from("consignor_intakes").update({ status: next, ...(next !== "review" ? { decided_at: new Date().toISOString() } : {}) }).eq("id", intakeId);
  return next;
}

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export const plnText = (n: number | null) => (n === null ? "–" : new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN" }).format(n));

/** E-mail do komisanta (cicho pomija, gdy brak SMTP albo adresu). Zwraca, czy wysłano. */
export async function mailConsignor(db: SupabaseClient, consignorId: string, subject: string, bodyHtml: string, link?: { href: string; label: string }) {
  try {
    if (!(await mailConfigured())) return false;
    const { data: c } = await db.from("consignors").select("email").eq("id", consignorId).maybeSingle();
    if (!c?.email) return false;
    const company = await getCompany(db);
    await sendMail(c.email, `${subject} – ${company.name}`, `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#17232f;max-width:560px">
      <p style="margin:0 0 12px">Dzień dobry,</p>${bodyHtml}
      ${link ? `<p style="margin:16px 0"><a href="${esc(link.href)}" style="display:inline-block;background:#17232f;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px">${esc(link.label)}</a></p><p style="margin:0;color:#5b6878;font-size:13px">Jeśli przycisk nie działa, wklej adres: ${esc(link.href)}</p>` : ""}
      <p style="margin:16px 0 0">Pozdrawiamy<br><b>${esc(company.name)}</b></p></div>`);
    return true;
  } catch {
    return false;
  }
}

export async function mailCompany(db: SupabaseClient, subject: string, html: string) {
  try {
    if (!(await mailConfigured())) return;
    const company = await getCompany(db);
    if (company.email) await sendMail(company.email, subject, html);
  } catch {
    // powiadomienie nie jest konieczne
  }
}

export const itemsTable = (rows: { title: string; option: string | null; price: number | null; note?: string }[]) =>
  `<table style="border-collapse:collapse;margin:0 0 14px;font-size:14px">${rows.map((r) => `<tr><td style="padding:3px 10px 3px 0">${esc(`${r.title}${r.option ? ` · ${r.option}` : ""}`)}</td><td style="padding:3px 10px 3px 0;text-align:right;white-space:nowrap">${plnText(r.price)}</td><td style="padding:3px 0;color:#5b6878">${esc(r.note ?? "")}</td></tr>`).join("")}</table>`;

export { esc as escHtml };
