import type { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireSection } from "@/lib/auth";
import { renderInvoicePdf, type InvoiceForPdf } from "@/lib/invoices/pdf";

export const dynamic = "force-dynamic";

export async function GET(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Faktury: dział Faktury, Sprzedaż albo Kasa (nie każdy zalogowany pracownik).
  try {
    await requireSection("faktury", "sprzedaz", "kasa");
  } catch {
    return new Response("Brak dostępu do faktur.", { status: 403 });
  }
  const db = await createClient();
  const { data: inv } = await db.from("invoices").select("*").eq("id", id).maybeSingle();
  if (!inv) return new Response("Nie znaleziono", { status: 404 });
  const { data: items } = await db.from("invoice_items").select("*").eq("invoice_id", id).order("position");
  const pdf = await renderInvoicePdf({ ...(inv as InvoiceForPdf), items: (items ?? []) as InvoiceForPdf["items"] });
  return new Response(Buffer.from(pdf), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${inv.number.replace(/\//g, "-")}.pdf"`, "Cache-Control": "private, no-store" },
  });
}
