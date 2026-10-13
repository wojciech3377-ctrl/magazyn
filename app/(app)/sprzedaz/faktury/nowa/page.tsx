import Link from "next/link";
import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageHeader, Notice } from "@/components/ui";
import { draftFromConsignorShipment, draftFromInvoice, draftFromOrder, draftFromPos, todayPl, type InvoiceDraft } from "@/lib/invoices/service";
import { ksefConfigured } from "@/lib/ksef/client";
import { InvoiceForm } from "../InvoiceForm";
import { defaultOrderStore } from "@/lib/orders/default-store";

const UUID = /^[0-9a-f-]{36}$/i;

/** Nowa faktura: do zamówienia (?zamowienie=), do sprzedaży stacjonarnej (?kasa=), podobna do innej (?podobna=) albo pusta. */
export default async function NewInvoicePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  await requireProfile();
  // Paragony (PAR) wystawia się teraz w Kasie („Drukuj paragon PDF”, opcja „Wysyłka”) – tu tylko faktury do KSeF.
  if (sp.typ === "paragon") redirect(sp.kasa && UUID.test(sp.kasa) ? `/kasa/${sp.kasa}` : "/kasa");
  const receipt = false;
  const db = createAdminClient();
  let draft: InvoiceDraft | null = null;
  if (sp.zamowienie && UUID.test(sp.zamowienie)) draft = await draftFromOrder(db, sp.zamowienie);
  else if (sp.kasa && UUID.test(sp.kasa)) draft = await draftFromPos(db, sp.kasa);
  else if (sp.podobna && UUID.test(sp.podobna)) draft = await draftFromInvoice(db, sp.podobna);
  else if (sp.komis_wysylka && UUID.test(sp.komis_wysylka)) draft = await draftFromConsignorShipment(db, sp.komis_wysylka);
  const existing = draft && (draft.orderId || draft.posOrderId)
    ? (await (draft.orderId ? db.from("invoices").select("id, number").eq("order_id", draft.orderId) : db.from("invoices").select("id, number").eq("pos_order_id", draft.posOrderId!))[receipt ? "eq" : "neq"]("kind", "receipt").not("status", "in", "(rejected,cancelled)").limit(1).maybeSingle()).data
    : null;
  draft ??= {
    buyer: { name: "", nip: null, address1: null, address2: null, country: "PL", email: null, company: true },
    issueDate: todayPl(), saleDate: todayPl(), paymentMethod: "transfer", paid: false, paidAt: null, dueDate: todayPl(),
    items: [], orderId: null, posOrderId: null, notes: null,
  };
  const { data: stores } = await db.from("stores").select("id, name").order("name");
  const storeList = (stores ?? []) as { id: string; name: string }[];
  const defaultStore = await defaultOrderStore(db, storeList);
  if (receipt) draft = { ...draft, paid: true, paidAt: draft.paidAt ?? draft.issueDate, dueDate: null, paymentMethod: sp.zamowienie || sp.kasa ? draft.paymentMethod : "cash" };
  return (
    <>
      <PageHeader
        title={receipt ? "Nowy paragon" : sp.podobna ? "Nowa faktura (podobna)" : "Nowa faktura"}
        sub={receipt ? "Numer nadawany przy wydruku: PAR/miesiąc/kolejny – od 1 w każdym miesiącu." : "Numer nadawany automatycznie: FVM/kolejny/rok – kolejny po ostatnio wystawionej."}
        actions={<Link className="btn-secondary" href="/sprzedaz?widok=faktury">Wróć</Link>}
      />
      {existing && <div className="mb-4"><Notice tone="error">Do tej sprzedaży jest już {receipt ? "paragon" : "faktura"} <Link className="underline" href={`/sprzedaz/faktury/${existing.id}`}>{existing.number}</Link>.</Notice></div>}
      <InvoiceForm draft={draft} ksefReady={ksefConfigured()} receipt={receipt} stores={storeList} defaultStore={defaultStore} />
    </>
  );
}
