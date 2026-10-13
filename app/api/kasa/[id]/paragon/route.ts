import type { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { can } from "@/lib/permissions";
import { renderInvoicePdf, type InvoiceForPdf } from "@/lib/invoices/pdf";
import { invoiceTotals, onlyDigits } from "@/lib/invoices/xml";
import { getCompany } from "@/lib/contracts/settings";
import { getFiscalSettings, rateOf } from "@/lib/fiscal/jobs";

export const dynamic = "force-dynamic";

const PAY: Record<string, string> = { card: "card", cash: "cash", blik: "mobile", transfer: "transfer", other: "cash" };
const day = (iso: string) => new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });

/**
 * Paragon PDF do sprzedaży w Kasie – z numerem paragonu fiskalnego z drukarki (kopia do druku / e-maila, bez KSeF).
 * Sprzedaż z wysyłką (bez paragonu fiskalnego) ma paragon PAR – wtedy jego PDF.
 */
export async function GET(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Nie znaleziono", { status: 404 });
  const db = await createClient();
  const { data: auth } = await db.auth.getClaims();
  if (!auth?.claims?.sub) return new Response("unauthorized", { status: 401 });
  const { data: profile } = await db.from("profiles").select("active, role, permissions").eq("id", auth.claims.sub).maybeSingle();
  if (!profile?.active || !(can(profile, "kasa") || can(profile, "sprzedaz"))) return new Response("Brak dostępu", { status: 403 });

  const { data: o } = await db.from("pos_orders").select("id, code, created_at, payment_method").eq("id", id).maybeSingle();
  if (!o) return new Response("Nie znaleziono", { status: 404 });
  const { data: receipt } = await db.from("receipts").select("number, issued_at, items").eq("pos_order_id", id).order("issued_at", { ascending: false }).limit(1).maybeSingle();
  if (!receipt) {
    const { data: par } = await db.from("invoices").select("id").eq("pos_order_id", id).eq("kind", "receipt").not("status", "in", "(rejected,cancelled)").limit(1).maybeSingle();
    if (par) return Response.redirect(new URL(`/api/faktury/${par.id}/pdf`, _.url), 302);
    return new Response("Paragon jeszcze się nie wydrukował – spróbuj za chwilę.", { status: 409, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  const admin = createAdminClient();
  const [company, fiscal] = await Promise.all([getCompany(admin), getFiscalSettings(admin)]);
  type R = { name: string; quantity?: number; price_brutto: number; tax_rate: number; ptu?: string };
  const items = ((receipt.items ?? []) as R[]).map((r, k) => {
    const qty = Number(r.quantity ?? 1);
    const is23 = r.ptu ? rateOf(fiscal, r.ptu) === 23 : Number(r.tax_rate) === 23;
    return { position: k + 1, name: r.name, quantity: qty, unit: "szt.", unit_price_gross: Number(r.price_brutto), total_gross: Math.round(Number(r.price_brutto) * qty * 100) / 100, vat: is23 ? "23" : "margin" };
  });
  const t = invoiceTotals(items as Parameters<typeof invoiceTotals>[0]);
  const issued = day(receipt.issued_at as string);
  const inv: InvoiceForPdf = {
    kind: "receipt",
    number: String(receipt.number),
    issue_date: issued, sale_date: day(o.created_at as string), place: company.city.replace(/^\d{2}-\d{3}\s*/, "") || null,
    seller: { name: company.name, nip: onlyDigits(company.nip), address1: company.street, address2: company.city, country: "PL", email: company.email, bank_account: null },
    buyer: { name: "" },
    payment_method: PAY[o.payment_method as string] ?? "cash", paid: true, paid_at: issued, due_date: null, currency: "PLN",
    total_gross: t.total, net_23: t.net23, vat_23: t.vat23, margin_total: t.margin,
    notes: `Sprzedaż ${o.code}. Kopia paragonu fiskalnego nr ${receipt.number} wydrukowanego na drukarce fiskalnej.`,
    ksef_number: null, xml_hash: null, status: "issued", items,
  };
  const pdf = await renderInvoicePdf(inv);
  return new Response(Buffer.from(pdf), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="paragon-${String(receipt.number).replace(/[^A-Za-z0-9_-]/g, "-")}.pdf"`, "Cache-Control": "private, no-store" },
  });
}
