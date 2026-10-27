"use client";

import { useActionState, useState } from "react";
import { issueCorrectionAction, type InvoiceFormState } from "../../actions";

type Row = { name: string; quantity: number; unit: string; unit_price_gross: number; vat: "23" | "margin" };
const pln = (n: number) => new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN" }).format(n);
const today = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw" }).format(new Date());
const sum = (rows: Row[]) => rows.reduce((s, r) => s + Math.round(r.quantity * r.unit_price_gross * 100) / 100, 0);

/** Pozycje przed korektą (bez zmian) i po korekcie (do edycji); na dole różnica i „Wystaw korektę”. */
export function CorrectionForm({ originalId, before }: { originalId: string; before: Row[] }) {
  const [state, action, pending] = useActionState<InvoiceFormState, FormData>(issueCorrectionAction, null);
  const [after, setAfter] = useState<Row[]>(before.map((r) => ({ ...r })));
  const set = (i: number, patch: Partial<Row>) => setAfter((a) => a.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const diff = Math.round((sum(after) - sum(before)) * 100) / 100;

  return (
    <form action={action} className="space-y-5">
      <input type="hidden" name="original_id" value={originalId} />
      <input type="hidden" name="items" value={JSON.stringify(after)} />
      <section className="card overflow-x-auto p-4">
        <h2 className="h2 mb-2">Przed korektą</h2>
        <table className="table">
          <thead><tr><th>Nazwa</th><th className="text-right">Ilość</th><th className="text-right">Cena brutto</th><th className="text-right">Wartość</th><th>VAT</th></tr></thead>
          <tbody>
            {before.map((r, i) => <tr key={i} className="text-muted"><td>{r.name}</td><td className="text-right">{r.quantity} {r.unit}</td><td className="text-right tabular-nums">{pln(r.unit_price_gross)}</td><td className="text-right tabular-nums">{pln(r.quantity * r.unit_price_gross)}</td><td>{r.vat === "23" ? "23%" : "marża"}</td></tr>)}
            <tr><td colSpan={3} className="text-right font-medium">Razem</td><td className="text-right font-semibold tabular-nums">{pln(sum(before))}</td><td /></tr>
          </tbody>
        </table>
      </section>

      <section className="card overflow-x-auto p-4">
        <h2 className="h2 mb-2">Po korekcie</h2>
        {/* Na komputerze w wierszu, na telefonie jako karta z podpisami pól. */}
        <div className="divide-y divide-line">
          <div className="hidden gap-2 pb-2 text-xs font-medium text-muted sm:grid sm:grid-cols-[minmax(0,1fr)_6rem_8rem_7rem_8rem_3.5rem]">
            <span>Nazwa</span><span className="text-right">Ilość</span><span className="text-right">Cena brutto</span><span className="text-right">Wartość</span><span>VAT</span><span />
          </div>
          {after.map((r, i) => (
            <div key={i} className="grid grid-cols-6 items-end gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_6rem_8rem_7rem_8rem_3.5rem] sm:items-center sm:py-2">
              <label className="col-span-6 sm:col-span-1"><span className="mb-1 block text-xs text-muted sm:hidden">Nazwa</span>
                <input className="input" value={r.name} onChange={(e) => set(i, { name: e.target.value })} aria-label="Nazwa" /></label>
              <label className="col-span-2 sm:col-span-1"><span className="mb-1 block text-xs text-muted sm:hidden">Ilość</span>
                <input className="input text-right" inputMode="decimal" value={r.quantity} onChange={(e) => set(i, { quantity: Number(e.target.value.replace(",", ".")) || 0 })} aria-label="Ilość" /></label>
              <label className="col-span-2 sm:col-span-1"><span className="mb-1 block text-xs text-muted sm:hidden">Cena brutto</span>
                <input className="input text-right" inputMode="decimal" value={r.unit_price_gross} onChange={(e) => set(i, { unit_price_gross: Number(e.target.value.replace(",", ".")) || 0 })} aria-label="Cena brutto" /></label>
              <span className="col-span-2 min-w-0 pb-2.5 text-right text-sm tabular-nums sm:col-span-1 sm:pb-0"><span className="block text-xs text-muted sm:hidden">Wartość</span><span className="whitespace-nowrap">{pln(r.quantity * r.unit_price_gross)}</span></span>
              <label className="col-span-4 sm:col-span-1"><span className="mb-1 block text-xs text-muted sm:hidden">VAT</span>
                <select className="input" value={r.vat} onChange={(e) => set(i, { vat: e.target.value as Row["vat"] })} aria-label="VAT">
                  <option value="margin">marża</option><option value="23">23%</option>
                </select></label>
              <button type="button" className="col-span-2 h-10 text-right text-sm text-bad hover:underline sm:col-span-1" onClick={() => setAfter((a) => a.filter((_, k) => k !== i))}>usuń</button>
            </div>
          ))}
          {!after.length && <p className="py-4 text-center text-sm text-muted">Wszystkie pozycje usunięte – korekta do zera.</p>}
        </div>
        <button type="button" className="btn-secondary mt-2" onClick={() => setAfter((a) => [...a, { name: "", quantity: 1, unit: "szt.", unit_price_gross: 0, vat: "margin" }])}>Dodaj pozycję</button>
        <button type="button" className="btn-secondary ml-2 mt-2" onClick={() => setAfter([])}>Korekta do zera (zwrot całości)</button>
      </section>

      <section className="card grid gap-3 p-4 md:grid-cols-3">
        <div className="md:col-span-3">
          <label className="label" htmlFor="reason">Przyczyna korekty</label>
          <input id="reason" className="input" name="reason" placeholder="np. zwrot towaru, błędna cena" required maxLength={256} />
        </div>
        <div>
          <label className="label" htmlFor="type">Ujęcie korekty</label>
          <select id="type" className="input" name="type" defaultValue="2">
            <option value="1">w dacie faktury pierwotnej (błąd)</option>
            <option value="2">w dacie korekty (np. zwrot, rabat)</option>
            <option value="3">w innej dacie</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="issue_date">Data wystawienia korekty</label>
          <input id="issue_date" className="input" type="date" name="issue_date" defaultValue={today()} />
        </div>
        <div className="flex flex-col justify-end">
          <span className="text-sm text-muted">Różnica (do zwrotu / dopłaty)</span>
          <span className={`text-2xl font-semibold tabular-nums ${diff < 0 ? "text-bad" : diff > 0 ? "text-ok" : ""}`}>{pln(diff)}</span>
        </div>
      </section>

      {state?.error && <p className="text-sm text-bad" role="alert">{state.error}</p>}
      <button className="btn px-6 py-3 text-base" disabled={pending}>{pending ? "Wystawiam korektę…" : "Wystaw korektę"}</button>
      <p className="text-xs text-muted">Korekta dostaje numer FVK/n/rok i od razu idzie do KSeF. Faktury przyjętej w KSeF nie da się usunąć – korekta to jedyny sposób zmiany.</p>
    </form>
  );
}
