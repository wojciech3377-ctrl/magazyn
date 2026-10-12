import Link from "next/link";
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
  // Najpierw wybór dokumentu: faktura do KSeF albo paragon (bez nabywcy, do druku).
  if (sp.typ !== "ksef" && sp.typ !== "paragon") {
    const keep = new URLSearchParams(Object.entries(sp).filter((e): e is [string, string] => !!e[1] && e[0] !== "typ"));
    const href = (typ: string) => `/sprzedaz/faktury/nowa?${new URLSearchParams([...keep, ["typ", typ]])}`;
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-labelledby="doc-choice">
        <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl">
          <h1 id="doc-choice" className="mb-1 text-center text-lg font-semibold">Jaki dokument wystawić?</h1>
          <p className="mb-5 text-center text-sm text-muted">Faktura idzie do KSeF. Paragon to dokument do druku dla osoby prywatnej.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Link href={href("ksef")} className="group rounded-xl border-2 border-line p-5 text-center transition hover:border-accent hover:bg-sky-50">
              <span className="block text-2xl font-bold tracking-wide group-hover:text-accent">KSEF</span>
              <span className="mt-1 block text-sm text-muted">Faktura VAT z danymi nabywcy, numer FVM/n/rok</span>
            </Link>
            <Link href={href("paragon")} className="group rounded-xl border-2 border-line p-5 text-center transition hover:border-accent hover:bg-sky-50">
              <span className="block text-2xl font-bold tracking-wide group-hover:text-accent">PARAGON</span>
              <span className="mt-1 block text-sm text-muted">Bez danych nabywcy, nie idzie do KSeF, numer PAR/miesiąc/n</span>
            </Link>
          </div>
          <div className="mt-5 text-center"><Link className="text-sm text-muted hover:underline" href="/sprzedaz?widok=faktury">Anuluj</Link></div>
        </div>
      </div>
    );
  }
  const receipt = sp.typ === "paragon";
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
