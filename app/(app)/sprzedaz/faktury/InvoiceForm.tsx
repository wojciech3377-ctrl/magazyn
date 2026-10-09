"use client";

import { useActionState, useMemo, useState } from "react";
import { createInvoiceAction, type InvoiceFormState } from "./actions";
import type { InvoiceDraft } from "@/lib/invoices/service";

type Row = { name: string; quantity: string; unit: string; price: string; vat: "23" | "margin"; unit_id?: string | null; sale_id?: string | null; pos_item_id?: string | null; checkVat?: boolean };

const PAYMENTS: [string, string][] = [["card", "Karta / płatność online"], ["transfer", "Przelew"], ["cash", "Gotówka / pobranie"], ["mobile", "BLIK / płatność mobilna"]];
const pl = (n: number) => new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN" }).format(n);
const num = (v: string) => Number(v.replace(",", ".")) || 0;

export function InvoiceForm({ draft, ksefReady }: { draft: InvoiceDraft; ksefReady: boolean }) {
  const [state, action, pending] = useActionState<InvoiceFormState, FormData>(createInvoiceAction, null);
  const [company, setCompany] = useState(!!draft.buyer.company);
  const [paid, setPaid] = useState(draft.paid);
  const [rows, setRows] = useState<Row[]>(draft.items.length ? draft.items.map((i) => ({
    name: i.name, quantity: String(i.quantity), unit: i.unit, price: i.unit_price_gross.toFixed(2), vat: i.vat,
    unit_id: i.unit_id, sale_id: i.sale_id, pos_item_id: i.pos_item_id, checkVat: i.checkVat,
  })) : [{ name: "", quantity: "1", unit: "szt.", price: "", vat: "margin" }]);

  const totals = useMemo(() => {
    const g23 = rows.filter((r) => r.vat === "23").reduce((s, r) => s + num(r.price) * num(r.quantity), 0);
    const margin = rows.filter((r) => r.vat === "margin").reduce((s, r) => s + num(r.price) * num(r.quantity), 0);
    const net = Math.round((g23 / 1.23) * 100) / 100;
    return { g23, net, vat: Math.round((g23 - net) * 100) / 100, margin, total: g23 + margin };
  }, [rows]);
  const set = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const itemsJson = JSON.stringify(rows.map((r) => ({
    name: r.name, quantity: num(r.quantity), unit: r.unit, unit_price_gross: num(r.price), vat: r.vat, unit_id: r.unit_id, sale_id: r.sale_id, pos_item_id: r.pos_item_id, checkVat: r.checkVat,
  })));
  const needsCheck = rows.some((r) => r.checkVat);

  return (
    <form action={action} className="space-y-5">
      <input type="hidden" name="items" value={itemsJson} />
      <input type="hidden" name="company" value={company ? "1" : "0"} />
      <input type="hidden" name="paid" value={paid ? "1" : "0"} />
      {draft.orderId && <input type="hidden" name="order_id" value={draft.orderId} />}
      {draft.posOrderId && <input type="hidden" name="pos_order_id" value={draft.posOrderId} />}

      <section className="card p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="h2 mr-2">Nabywca</h2>
          {[false, true].map((c) => (
            <button key={String(c)} type="button" onClick={() => setCompany(c)}
              className={`rounded-md px-3 py-1 text-sm ${company === c ? "bg-ink text-white" : "text-muted hover:bg-panel"}`}>
              {c ? "Firma (z NIP)" : "Osoba prywatna"}
            </button>
          ))}
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div><label className="label" htmlFor="name">{company ? "Nazwa firmy" : "Imię i nazwisko"}</label><input id="name" className="input" name="name" defaultValue={draft.buyer.name} required /></div>
          {company && <div><label className="label" htmlFor="nip">NIP</label><input id="nip" className="input font-mono" name="nip" defaultValue={draft.buyer.nip ?? ""} placeholder="1234567890" required /></div>}
          <div><label className="label" htmlFor="address1">Ulica i numer</label><input id="address1" className="input" name="address1" defaultValue={draft.buyer.address1 ?? ""} /></div>
          <div className="grid grid-cols-[1fr_5rem] gap-2">
            <div><label className="label" htmlFor="address2">Kod pocztowy i miasto</label><input id="address2" className="input" name="address2" defaultValue={draft.buyer.address2 ?? ""} /></div>
            <div><label className="label" htmlFor="country">Kraj</label><input id="country" className="input uppercase" name="country" maxLength={2} defaultValue={draft.buyer.country ?? "PL"} /></div>
          </div>
          <div><label className="label" htmlFor="email">E-mail</label><input id="email" className="input" type="email" name="email" defaultValue={draft.buyer.email ?? ""} /></div>
        </div>
      </section>

      <section className="card overflow-x-auto p-4">
        <h2 className="h2 mb-3">Pozycje</h2>
        <table className="table">
          <thead><tr><th>Nazwa</th><th className="w-20">Ilość</th><th className="w-20">J.m.</th><th className="w-32">Cena brutto</th><th className="w-36">VAT</th><th className="w-28 text-right">Wartość</th><th /></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td><input className="input" value={r.name} onChange={(e) => set(i, { name: e.target.value })} aria-label="Nazwa" required /></td>
                <td><input className="input" inputMode="decimal" value={r.quantity} onChange={(e) => set(i, { quantity: e.target.value })} aria-label="Ilość" /></td>
                <td><input className="input" value={r.unit} onChange={(e) => set(i, { unit: e.target.value })} aria-label="Jednostka" /></td>
                <td><input className="input" inputMode="decimal" value={r.price} onChange={(e) => set(i, { price: e.target.value })} aria-label="Cena brutto" required /></td>
                <td>
                  <select className={`input ${r.checkVat ? "border-amber-400 bg-amber-50" : ""}`} value={r.vat} onChange={(e) => set(i, { vat: e.target.value as Row["vat"] })} aria-label="Stawka" title={r.checkVat ? "Brak sztuki z magazynu – sprawdź, czy to towar używany (marża)" : undefined}>
                    <option value="margin">VAT marża</option>
                    <option value="23">23%</option>
                  </select>
                </td>
                <td className="text-right tabular-nums">{pl(num(r.price) * num(r.quantity))}</td>
                <td><button type="button" className="text-muted hover:text-bad" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} aria-label="Usuń pozycję" disabled={rows.length === 1}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" className="btn-secondary mt-2 px-3 py-1 text-sm" onClick={() => setRows((rs) => [...rs, { name: "", quantity: "1", unit: "szt.", price: "", vat: "margin" }])}>+ Pozycja</button>
        <div className="mt-4 ml-auto max-w-sm space-y-1 text-sm">
          {totals.g23 > 0 && <><div className="flex justify-between"><span>Netto 23%</span><span className="tabular-nums">{pl(totals.net)}</span></div><div className="flex justify-between"><span>VAT 23%</span><span className="tabular-nums">{pl(totals.vat)}</span></div></>}
          {totals.margin > 0 && <div className="flex justify-between"><span>Procedura marży</span><span className="tabular-nums">{pl(totals.margin)}</span></div>}
          <div className="flex justify-between border-t border-line pt-1 text-base font-semibold"><span>Razem</span><span className="tabular-nums">{pl(totals.total)}</span></div>
        </div>
      </section>

      <section className="card grid gap-3 p-4 md:grid-cols-4">
        <div><label className="label" htmlFor="issue_date">Data wystawienia</label><input id="issue_date" className="input" type="date" name="issue_date" defaultValue={draft.issueDate} required /></div>
        <div><label className="label" htmlFor="sale_date">Data sprzedaży</label><input id="sale_date" className="input" type="date" name="sale_date" defaultValue={draft.saleDate} required /></div>
        <div>
          <label className="label" htmlFor="payment_method">Płatność</label>
          <select id="payment_method" className="input" name="payment_method" defaultValue={draft.paymentMethod}>
            {PAYMENTS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Status płatności</label>
          <div className="flex gap-1">
            {[true, false].map((p) => (
              <button key={String(p)} type="button" onClick={() => setPaid(p)}
                className={`flex-1 rounded-md border px-2 py-2 text-sm ${paid === p ? "border-ink bg-ink text-white" : "border-line hover:bg-panel"}`}>
                {p ? "Zapłacono" : "Do zapłaty"}
              </button>
            ))}
          </div>
        </div>
        {paid
          ? <div><label className="label" htmlFor="paid_at">Data zapłaty</label><input id="paid_at" className="input" type="date" name="paid_at" defaultValue={draft.paidAt ?? draft.issueDate} /></div>
          : <div><label className="label" htmlFor="due_date">Termin płatności</label><input id="due_date" className="input" type="date" name="due_date" defaultValue={draft.dueDate ?? draft.issueDate} /></div>}
        <div className="md:col-span-3"><label className="label" htmlFor="notes">Uwagi (na fakturze)</label><input id="notes" className="input" name="notes" defaultValue={draft.notes ?? ""} /></div>
      </section>

      <div className="flex flex-wrap items-center gap-4">
        {ksefReady
          ? <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="send_ksef" value="1" defaultChecked /> Wyślij od razu do KSeF</label>
          : <span className="text-sm text-warn">KSeF nie jest skonfigurowany – faktura zostanie tylko zapisana.</span>}
        {needsCheck && <label className="flex items-center gap-2 text-sm text-warn"><input type="checkbox" name="vat_checked" value="1" /> Sprawdziłem stawki VAT pozycji na pomarańczowo</label>}
        {state?.error && <p className="text-sm text-bad" role="alert">{state.error}</p>}
        <button className="btn ml-auto" disabled={pending}>{pending ? "Wystawiam…" : "Wystaw fakturę"}</button>
      </div>
    </form>
  );
}
