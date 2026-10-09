import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { dateOnly, dateTime, money } from "@/lib/labels";
import { Field, Notice, PageHeader, Pill } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { ksefConfigured } from "@/lib/ksef/client";
import { checkKsefAction, sendToKsefAction, voidInvoiceAction } from "../actions";
import { KSEF_TRANSIENT } from "@/lib/invoices/service";
import { KSEF_STATUS } from "@/lib/invoices/labels";

const PAY: Record<string, string> = { cash: "gotówka", card: "karta", transfer: "przelew", mobile: "BLIK / mobilna" };

export default async function InvoicePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const { supabase } = await requireProfile();
  const { data: inv } = await supabase.from("invoices").select("*, order:orders(id, name), pos:pos_orders(id, code)").eq("id", id).maybeSingle();
  if (!inv) notFound();
  const { data: items } = await supabase.from("invoice_items").select("*").eq("invoice_id", id).order("position");
  const st = KSEF_STATUS[inv.status] ?? KSEF_STATUS.issued;
  const buyer = inv.buyer as { name: string; nip?: string | null; address1?: string | null; address2?: string | null; country?: string | null; email?: string | null };
  const order = inv.order as { id: string; name: string } | null;
  const pos = inv.pos as { id: string; code: string } | null;

  return (
    <>
      <PageHeader
        title={`Faktura ${inv.number}`}
        sub={<>{dateOnly(inv.issue_date)} · {buyer.name}{order && <> · <Link className="text-accent hover:underline" href={`/sprzedaz/${order.id}`}>zamówienie {order.name}</Link></>}{pos && <> · <Link className="text-accent hover:underline" href={`/kasa/${pos.id}`}>{pos.code}</Link></>}</>}
        actions={
          <>
            <a className="btn" href={`/api/faktury/${inv.id}/pdf`} target="_blank" rel="noreferrer">PDF</a>
            <a className="btn-secondary" href={`/api/faktury/${inv.id}/xml`}>XML</a>
            <Link className="btn-secondary" href="/sprzedaz?widok=faktury">Wróć</Link>
          </>
        }
      />
      {sp.ok && <div className="mb-4"><Notice tone="ok">{sp.ok}</Notice></div>}
      {sp.blad && <div className="mb-4"><Notice tone="error">{sp.blad}</Notice></div>}

      <section className="card mb-5 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="h2">KSeF</h2>
          <Pill tone={st.tone}>{st.text}</Pill>
          {inv.ksef_number && <span className="font-mono text-sm">{inv.ksef_number}</span>}
          {inv.ksef_accepted_at && <span className="text-sm text-muted">{dateTime(inv.ksef_accepted_at)}</span>}
          <div className="ml-auto flex gap-2">
            {(inv.status === "issued" || (inv.status === "rejected" && (!inv.ksef_status_code || KSEF_TRANSIENT.has(inv.ksef_status_code)))) && ksefConfigured() && (
              <form action={sendToKsefAction}><input type="hidden" name="id" value={inv.id} /><SubmitButton pendingText="Wysyłam…">{inv.status === "rejected" ? "Wyślij ponownie" : "Wyślij do KSeF"}</SubmitButton></form>
            )}
            {inv.status === "rejected" && (
              <form action={voidInvoiceAction}><input type="hidden" name="id" value={inv.id} /><SubmitButton className="btn-secondary" pendingText="…">Unieważnij i wystaw nową</SubmitButton></form>
            )}
            {inv.status === "sending" && (
              <form action={checkKsefAction}><input type="hidden" name="id" value={inv.id} /><SubmitButton className="btn-secondary" pendingText="Sprawdzam…">Sprawdź status</SubmitButton></form>
            )}
          </div>
        </div>
        {inv.ksef_status && inv.status !== "accepted" && <p className={`mt-2 text-sm ${inv.status === "rejected" ? "text-bad" : "text-muted"}`}>{inv.ksef_status}</p>}
      </section>

      <div className="grid gap-5 lg:grid-cols-3">
        <section className="card p-4">
          <h2 className="h2 mb-2">Nabywca</h2>
          <div className="space-y-1 text-sm">
            <div className="font-medium">{buyer.name}</div>
            {buyer.nip && <div>NIP: {buyer.nip}</div>}
            <div className="text-muted">{[buyer.address1, buyer.address2, buyer.country && buyer.country !== "PL" ? buyer.country : null].filter(Boolean).join(", ")}</div>
            {buyer.email && <div>{buyer.email}</div>}
          </div>
        </section>
        <section className="card grid grid-cols-2 gap-3 p-4 lg:col-span-2">
          <Field label="Data wystawienia">{dateOnly(inv.issue_date)}</Field>
          <Field label="Data sprzedaży">{dateOnly(inv.sale_date)}</Field>
          <Field label="Płatność">{PAY[inv.payment_method] ?? inv.payment_method}</Field>
          <Field label={inv.paid ? "Zapłacono" : "Termin"}>{inv.paid ? dateOnly(inv.paid_at) : dateOnly(inv.due_date)}</Field>
        </section>
      </div>

      <section className="card mt-5 overflow-x-auto">
        <table className="table">
          <thead><tr><th>Lp.</th><th>Nazwa</th><th className="text-right">Ilość</th><th className="text-right">Cena brutto</th><th className="text-right">Wartość</th><th>VAT</th></tr></thead>
          <tbody>
            {items?.map((i) => (
              <tr key={i.id}>
                <td className="text-muted">{i.position}</td>
                <td>{i.name}</td>
                <td className="text-right tabular-nums">{Number(i.quantity)} {i.unit}</td>
                <td className="text-right tabular-nums">{money(i.unit_price_gross)}</td>
                <td className="text-right tabular-nums">{money(i.total_gross)}</td>
                <td>{i.vat === "23" ? "23%" : "marża"}</td>
              </tr>
            ))}
            {Number(inv.net_23) > 0 && <tr><td colSpan={4} className="text-right">Netto 23% / VAT</td><td className="text-right tabular-nums">{money(inv.net_23)} / {money(inv.vat_23)}</td><td /></tr>}
            <tr><td colSpan={4} className="text-right font-medium">Razem</td><td className="text-right text-lg font-semibold tabular-nums">{money(inv.total_gross)}</td><td /></tr>
          </tbody>
        </table>
      </section>
    </>
  );
}
