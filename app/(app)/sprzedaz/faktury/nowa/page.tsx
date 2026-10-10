import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageHeader, Notice } from "@/components/ui";
import { draftFromInvoice, draftFromOrder, draftFromPos, todayPl, type InvoiceDraft } from "@/lib/invoices/service";
import { ksefConfigured } from "@/lib/ksef/client";
import { InvoiceForm } from "../InvoiceForm";

const UUID = /^[0-9a-f-]{36}$/i;

/** Nowa faktura: do zamówienia (?zamowienie=), do sprzedaży stacjonarnej (?kasa=), podobna do innej (?podobna=) albo pusta. */
export default async function NewInvoicePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  await requireProfile();
  const db = createAdminClient();
  let draft: InvoiceDraft | null = null;
  if (sp.zamowienie && UUID.test(sp.zamowienie)) draft = await draftFromOrder(db, sp.zamowienie);
  else if (sp.kasa && UUID.test(sp.kasa)) draft = await draftFromPos(db, sp.kasa);
  else if (sp.podobna && UUID.test(sp.podobna)) draft = await draftFromInvoice(db, sp.podobna);
  const existing = draft && (draft.orderId || draft.posOrderId)
    ? (await (draft.orderId ? db.from("invoices").select("id, number").eq("order_id", draft.orderId) : db.from("invoices").select("id, number").eq("pos_order_id", draft.posOrderId!)).not("status", "in", "(rejected,cancelled)").limit(1).maybeSingle()).data
    : null;
  draft ??= {
    buyer: { name: "", nip: null, address1: null, address2: null, country: "PL", email: null, company: true },
    issueDate: todayPl(), saleDate: todayPl(), paymentMethod: "transfer", paid: false, paidAt: null, dueDate: todayPl(),
    items: [], orderId: null, posOrderId: null, notes: null,
  };
  return (
    <>
      <PageHeader title={sp.podobna ? "Nowa faktura (podobna)" : "Nowa faktura"} sub="Numer nadawany automatycznie: FVM/kolejny/rok – kolejny po ostatnio wystawionej." actions={<Link className="btn-secondary" href="/sprzedaz?widok=faktury">Wróć</Link>} />
      {existing && <div className="mb-4"><Notice tone="error">Do tej sprzedaży jest już faktura <Link className="underline" href={`/sprzedaz/faktury/${existing.id}`}>{existing.number}</Link>.</Notice></div>}
      <InvoiceForm draft={draft} ksefReady={ksefConfigured()} />
    </>
  );
}
