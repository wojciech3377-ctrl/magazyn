"use client";

import Link from "next/link";
import { useState } from "react";
import { ContractFileInput } from "@/components/ContractFileInput";
import { SubmitButton } from "@/components/SubmitButton";
import { receiveNoDocUnits, transitContract, transitInvoice } from "./transit-doc-actions";
import { PrintGroup } from "./ReceiveChecklist";
import { DateField } from "@/components/DateField";

export type TransitUnit = { id: string; code: string; title: string; option: string; location: string; price: number | null; productId?: string | null; storeId?: string | null; supplier?: string | null };

/**
 * W drodze bez dokumentu: zaznacz rzeczy i jednym kliknięciem „Umowa do podpisu” (osobna umowa na każdą parę po
 * zatwierdzeniu) albo „Faktura” (jeden plik faktury przy każdej zaznaczonej rzeczy).
 */
export function TransitNoDoc({ units, prices }: { units: TransitUnit[]; prices: boolean }) {
  const [sel, setSel] = useState<Set<string>>(new Set(units.map((u) => u.id)));
  const [price, setPrice] = useState<Record<string, string>>(Object.fromEntries(units.map((u) => [u.id, u.price != null ? String(u.price) : ""])));
  const [mode, setMode] = useState<"none" | "invoice">("none");
  const picked = units.filter((u) => sel.has(u.id));
  const payload = JSON.stringify(picked.map((u) => ({ unit_id: u.id, price: price[u.id] ?? "" })));
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div className="card space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">bez umowy</span>
        <b>W drodze – bez dokumentu</b>
        <span className="text-sm text-muted">{units.length} szt. · zaznaczono {picked.length}</span>
        <label className="ml-auto flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4" checked={picked.length === units.length} onChange={() => setSel(picked.length === units.length ? new Set() : new Set(units.map((u) => u.id)))} /> wszystkie</label>
      </div>
      <ul className="divide-y divide-line rounded-lg border border-line">
        {units.map((u) => (
          <li key={u.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
            <input type="checkbox" className="h-4 w-4" checked={sel.has(u.id)} onChange={() => toggle(u.id)} aria-label={`Zaznacz ${u.code}`} />
            <Link className="min-w-0 flex-1 hover:underline" href={`/magazyn/${u.id}`}>{u.title} · <b>{u.option}</b> <span className="font-mono text-xs text-muted">{u.code}</span> <span className="text-xs text-muted">· {u.location}</span>{u.supplier && <span className="text-xs text-muted"> · od: <b className="font-medium text-ink">{u.supplier}</b></span>}</Link>
            {prices && <input className="input w-32 text-right tabular-nums" inputMode="decimal" placeholder="cena zakupu" value={price[u.id] ?? ""} onChange={(e) => setPrice((p) => ({ ...p, [u.id]: e.target.value }))} aria-label={`Cena zakupu ${u.code}`} />}
          </li>
        ))}
      </ul>
      <form action={receiveNoDocUnits}>
        {picked.map((u) => <input key={u.id} type="hidden" name="unit" value={u.id} />)}
        <PrintGroup units={picked}>
          <SubmitButton className="btn rounded-none shadow-none" pendingText="Przyjmuję…" disabled={!picked.length}>Przyjmij na magazyn ({picked.length})</SubmitButton>
        </PrintGroup>
      </form>
      <div className="flex flex-wrap items-center gap-2">
        <form action={transitContract} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="units" value={payload} />
          <input className="input w-56" type="email" name="seller_email" placeholder="e-mail sprzedającego (opcjonalnie)" aria-label="E-mail sprzedającego" />
          <select className="input w-auto" name="currency" defaultValue="" aria-label="Waluta umowy" title="Waluta umowy">
            <option value="">waluta: wybierze sprzedający</option>
            <option value="PLN">waluta: PLN</option>
            <option value="EUR">waluta: EUR</option>
          </select>
          <SubmitButton className="btn" pendingText="Tworzę umowę…" disabled={!picked.length}>Umowa do podpisu ({picked.length})</SubmitButton>
        </form>
        <button type="button" className="btn-secondary" disabled={!picked.length} onClick={() => setMode(mode === "invoice" ? "none" : "invoice")}>Dołącz fakturę ({picked.length})</button>
        <span className="text-xs text-muted">Umowa: po podpisie i zatwierdzeniu każda para dostaje osobną umowę. Faktura: ten sam dokument przy każdej rzeczy.</span>
      </div>
      {mode === "invoice" && (
        <form action={transitInvoice} className="grid gap-3 rounded-lg border border-line p-3 sm:grid-cols-2">
          <input type="hidden" name="units" value={payload} />
          <div className="sm:col-span-2"><ContractFileInput label="Plik faktury (PDF lub zdjęcie)" /></div>
          <div><label className="label" htmlFor="doc_number">Numer faktury</label><input id="doc_number" name="doc_number" className="input" required /></div>
          <div><label className="label" htmlFor="doc_date">Data faktury</label><DateField id="doc_date" name="doc_date" /></div>
          <div><label className="label" htmlFor="inv_currency">Waluta</label>
            <select id="inv_currency" name="currency" className="input" defaultValue="PLN"><option value="PLN">PLN – złoty</option><option value="EUR">EUR – euro</option></select>
          </div>
          <div className="sm:col-span-2"><label className="label" htmlFor="counterparty">Sprzedawca</label><input id="counterparty" name="counterparty" className="input" placeholder="np. firma, od której kupujesz" defaultValue={picked.find((u) => u.supplier)?.supplier ?? ""} /></div>
          <div className="sm:col-span-2"><SubmitButton pendingText="Zapisuję…">Zapisz fakturę dla {picked.length} szt.</SubmitButton></div>
        </form>
      )}
    </div>
  );
}
