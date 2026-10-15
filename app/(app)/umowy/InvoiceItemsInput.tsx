"use client";

import { useState } from "react";

type Row = { title: string; option: string; qty: string; price: string };
const empty = (): Row => ({ title: "", option: "", qty: "1", price: "" });

/**
 * „Przedmioty faktury” – opcjonalny opis, co jest na umowie / fakturze (nazwa, rozmiar, ilość, cena).
 * Tylko opis: nie przypina sztuk i nie zmienia kwot zakupu. Pole ukryte `manual_items` (JSON).
 */
export function InvoiceItemsInput({ canSeePrices }: { canSeePrices: boolean }) {
  const [rows, setRows] = useState<Row[]>([]);
  const set = (k: number, patch: Partial<Row>) => setRows((r) => r.map((x, i) => (i === k ? { ...x, ...patch } : x)));
  const filled = rows.filter((r) => r.title.trim());
  return (
    <div className="space-y-2 rounded-xl border border-line p-3 md:col-span-2">
      <input type="hidden" name="manual_items" value={JSON.stringify(filled)} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">Przedmioty faktury <span className="font-normal text-muted">(opcjonalnie)</span></span>
        <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={() => setRows((r) => [...r, empty()])}>+ Dodaj przedmiot</button>
      </div>
      {rows.length === 0 && <p className="text-xs text-muted">Możesz wpisać, co jest na fakturze, np. „Air Force 1 · 42 · 1 szt. · 300”. Nie jest to wymagane.</p>}
      {rows.map((r, k) => (
        <div key={k} className="grid grid-cols-[1fr_5rem] gap-2 sm:grid-cols-[1fr_6rem_4rem_7rem_auto]">
          <input className="input" placeholder="Nazwa przedmiotu" value={r.title} maxLength={120} onChange={(e) => set(k, { title: e.target.value })} aria-label="Nazwa przedmiotu" />
          <input className="input" placeholder="Rozmiar" value={r.option} maxLength={40} onChange={(e) => set(k, { option: e.target.value })} aria-label="Rozmiar" />
          <input className="input" placeholder="Ilość" inputMode="numeric" value={r.qty} onChange={(e) => set(k, { qty: e.target.value.replace(/[^\d]/g, "").slice(0, 4) })} aria-label="Ilość" />
          {canSeePrices ? <input className="input" placeholder="Cena / szt." inputMode="decimal" value={r.price} onChange={(e) => set(k, { price: e.target.value })} aria-label="Cena za sztukę" /> : <span />}
          <button type="button" className="text-sm text-bad hover:underline" onClick={() => setRows((x) => x.filter((_, i) => i !== k))}>usuń</button>
        </div>
      ))}
    </div>
  );
}
