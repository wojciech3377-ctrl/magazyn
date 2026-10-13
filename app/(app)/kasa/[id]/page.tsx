import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { dateTime, money } from "@/lib/labels";
import { Notice, PageHeader } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { retryPosBase } from "../actions";
import { ReceiptView } from "@/components/ReceiptView";
import { getCompany } from "@/lib/contracts/settings";
import { getFiscalSettings, rateOf } from "@/lib/fiscal/jobs";
import { createAdminClient } from "@/lib/supabase/admin";
import { PosReceiptButton } from "@/components/PosReceiptButton";
import { ReceiptPdfButton } from "@/components/ReceiptPdfButton";
import { AutoOpen } from "@/components/AutoOpen";
import type { JobView } from "@/app/(app)/sprzedaz/receipt-actions";

const PAYMENT: Record<string, string> = { card: "karta", cash: "gotówka", blik: "BLIK", transfer: "przelew", other: "inna" };

export default async function PosOrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const { supabase } = await requireProfile();
  const { data: o } = await supabase.from("pos_orders").select("*, store:stores(name)").eq("id", id).maybeSingle();
  if (!o) notFound();
  const { data: receipt } = await supabase.from("receipts").select("number, issued_at, source, items, base_receipt_id").eq("pos_order_id", id).order("issued_at", { ascending: false }).limit(1).maybeSingle();
  const company = await getCompany(supabase);
  const fiscal = await getFiscalSettings(createAdminClient());
  const { data: receiptJob } = await supabase.from("receipt_jobs").select("id, status, receipt_number, error, claimed_at, number").eq("pos_order_id", id).neq("status", "cancelled").order("created_at", { ascending: false }).limit(1).maybeSingle();
  const { data: invoice } = await supabase.from("invoices").select("id, number").eq("pos_order_id", id).neq("kind", "receipt").not("status", "in", "(rejected,cancelled)").limit(1).maybeSingle();
  // Sprzedaż z wysyłką: paragon PDF (PAR) bez paragonu fiskalnego, poza JPK.
  const { data: par } = await supabase.from("invoices").select("id, number").eq("pos_order_id", id).eq("kind", "receipt").not("status", "in", "(rejected,cancelled)").limit(1).maybeSingle();
  const { data: shipOrder } = par ? await supabase.from("orders").select("id, name").eq("shopify_order_id", `par:${par.id}`).maybeSingle() : { data: null };
  const { data: items } = await supabase
    .from("pos_order_items")
    .select("id, price, status, name, ptu, quantity, unit:units(id, code, identifier, purchase_form, variant:variants(option, product:products(title)))")
    .eq("order_id", id);

  return (
    <>
      <PageHeader
        title={`Sprzedaż ${o.code}`}
        sub={`${(o.store as { name: string }).name} · ${dateTime(o.created_at)} · płatność: ${PAYMENT[o.payment_method] ?? o.payment_method}${o.customer ? ` · ${o.customer}` : ""}`}
        actions={
          <>
            {invoice
              ? <Link className="btn-secondary" href={`/sprzedaz/faktury/${invoice.id}`}>Faktura {invoice.number}</Link>
              : <Link className="btn-secondary" href={`/sprzedaz/faktury/nowa?kasa=${o.id}`}>Wystaw fakturę</Link>}
            <Link className="btn" href="/kasa">Nowa sprzedaż</Link>
          </>
        }
      />
      {sp.ok && <div className="mb-4"><Notice tone="ok">{sp.ok}</Notice></div>}
      {sp.blad && <div className="mb-4"><Notice tone="error">{sp.blad}</Notice></div>}
      {par ? (
        <div className="card mb-4 flex flex-wrap items-center gap-2 p-4 text-sm">
          <span className="text-muted">{shipOrder ? "Wysyłka – paragon PDF" : "Paragon PDF"}:</span>
          <b className="font-mono">{par.number}</b>
          <span className="text-muted">· bez paragonu fiskalnego, poza JPK</span>
          {shipOrder && <Link className="text-accent hover:underline" href={`/sprzedaz/${shipOrder.id}`}>zamówienie {shipOrder.name}</Link>}
          <span className="ml-auto"><ParPdfLink invoiceId={par.id as string} posOrderId={o.id as string} auto={sp.pdf === "1"} /></span>
        </div>
      ) : (
        <div className="card mb-4 flex flex-wrap items-center gap-2 p-4 text-sm">
          <span className="text-muted">Paragon:</span>
          {receipt ? <b className="font-mono">{receipt.number}</b> : !receiptJob && <span className="text-muted">jeszcze nie wystawiony</span>}
          {receipt && <span className="text-muted">· {dateTime(receipt.issued_at)}</span>}
          <span className="ml-auto flex flex-wrap items-center gap-2">
            {(!receipt || receiptJob) && <PosReceiptButton posOrderId={o.id} job={receiptJob as JobView | null} />}
            <ReceiptPdfButton posOrderId={o.id as string} ready={!!receipt} jobId={(receiptJob?.id as string | undefined) ?? null} auto={sp.pdf === "1"} />
          </span>
        </div>
      )}
      <div className="mb-4">
        {o.base_sync_status === "ok" && <Notice tone="ok">Stan w Shopify zmniejszony.</Notice>}
        {o.base_sync_status === "error" && (
          <Notice tone="error">
            <div className="whitespace-pre-line">Stan w Shopify nie zmieniony: {o.base_sync_error}</div>
            {(o.base_pending as unknown[]).length > 0 && (
              <form action={retryPosBase} className="mt-2">
                <input type="hidden" name="id" value={o.id} />
                <SubmitButton className="btn-secondary" pendingText="Wysyłam…">Wyślij ponownie do Shopify</SubmitButton>
              </form>
            )}
          </Notice>
        )}
      </div>
      <div className="mb-5">
        <ReceiptView
          company={{ name: company.name, street: company.street, city: company.city, nip: company.nip }}
          date={dateTime(receipt?.issued_at ?? o.created_at)}
          number={receipt?.number ?? o.code}
          transaction={receipt?.base_receipt_id ? String(receipt.base_receipt_id) : o.code}
          title={receipt ? "PARAGON FISKALNY" : "PODGLĄD (paragon jeszcze nie wydrukowany)"}
          lines={((receipt?.items as { name: string; price_brutto: number; tax_rate: number; quantity?: number }[] | null) ?? []).length
            ? (receipt!.items as { name: string; price_brutto: number; tax_rate: number; quantity?: number }[]).map((r) => ({ name: r.name, qty: Number(r.quantity ?? 1), price: Number(r.price_brutto), rate: Number(r.tax_rate) }))
            : (items ?? []).filter((i) => i.status !== "returned").map((i) => {
                const u = i.unit as unknown as { purchase_form: string; variant: { option: string; product: { title: string } } } | null;
                if (!u) return { name: i.name ?? "Pozycja", qty: Number(i.quantity ?? 1), price: Number(i.price), rate: rateOf(fiscal, i.ptu ?? "A") };
                return { name: `${u.variant.product.title} ${u.variant.option}`, qty: 1, price: Number(i.price), rate: i.ptu ? rateOf(fiscal, i.ptu) : u.purchase_form === "vat_23" ? 23 : 0 };
              })}
        />
      </div>
      <div className="card overflow-x-auto">
        <table className="table mtable mtable-flow">
          <thead><tr><th>Sztuka</th><th>Produkt</th><th className="text-right">Cena</th></tr></thead>
          <tbody>
            {items?.map((i) => {
              const u = i.unit as unknown as { id: string; code: string; identifier: string | null; variant: { option: string; product: { title: string } } } | null;
              if (!u) return (
                <tr key={i.id}>
                  <td className="text-xs text-muted">spoza magazynu · PTU {i.ptu}</td>
                  <td>{i.name}{Number(i.quantity ?? 1) !== 1 && <b> × {Number(i.quantity)}</b>}</td>
                  <td className="text-right tabular-nums">{money(Number(i.price) * Number(i.quantity ?? 1))}</td>
                </tr>
              );
              return (
                <tr key={i.id}>
                  <td className="font-mono text-xs"><Link className="text-accent hover:underline" href={`/magazyn/${u.id}`}>{u.code}</Link>{u.identifier && <span className="block text-muted">{u.identifier}</span>}</td>
                  <td>{u.variant.product.title} · <b>{u.variant.option}</b>{i.status === "returned" && <span className="ml-2 text-xs text-bad">zwrot</span>}</td>
                  <td className="text-right tabular-nums">{money(i.price)}</td>
                </tr>
              );
            })}
            <tr><td colSpan={2} className="text-right font-medium">Razem</td><td className="text-right text-lg font-semibold tabular-nums">{money(o.total)}</td></tr>
          </tbody>
        </table>
      </div>
    </>
  );
}

/** PDF paragonu PAR (sprzedaż z wysyłką) – po „Zakończ – wysyłka” otwiera się sam. */
function ParPdfLink({ invoiceId, posOrderId, auto }: { invoiceId: string; posOrderId: string; auto: boolean }) {
  const href = `/druk/pdf?src=${encodeURIComponent(`/api/faktury/${invoiceId}/pdf`)}&wroc=${encodeURIComponent(`/kasa/${posOrderId}`)}&dalej=${encodeURIComponent("/kasa")}&dalej_tekst=${encodeURIComponent("Nowa sprzedaż")}&nazwa=paragon&tytul=${encodeURIComponent("Paragon")}`;
  return (
    <>
      <a className="btn" href={href}>Drukuj paragon PDF</a>
      {auto && <AutoOpen href={href} />}
    </>
  );
}
