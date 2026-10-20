"use client";

import { useActionState, useState } from "react";
import { createContract } from "./actions";
import { ContractFileInput } from "@/components/ContractFileInput";
import { VariantPick } from "@/components/VariantPick";
import { ContractItemsPicker } from "./ContractItemsPicker";
import { DateField } from "@/components/DateField";
import { InvoiceItemsInput } from "./InvoiceItemsInput";

export function ContractForm({ consignors, defaultUnits, canSeePrices, returnTo = "", saleId = null, saleLabel = null, pickVariantStore = null, locations = [], canStock = false }: { consignors: { id: string; name: string }[]; defaultUnits: string; canSeePrices: boolean; returnTo?: string; saleId?: string | null; saleLabel?: string | null; pickVariantStore?: string | null; locations?: { id: string; label: string }[]; canStock?: boolean }) {
  const [state, action, pending] = useActionState(createContract, null);
  const [type, setType] = useState("purchase");
  return (
    <form action={action} className="card grid max-w-3xl gap-3 p-4 md:grid-cols-2">
      <input type="hidden" name="returnTo" value={returnTo} />
      {saleId && <input type="hidden" name="sale_id" value={saleId} />}
      {!saleId && <CopiesCounter />}
      {saleLabel && <p className="rounded-md bg-sky-50 p-2 text-sm md:col-span-2">Umowa do sprzedanego przedmiotu: <b>{saleLabel}</b>. Przedmiot dostanie sztukę w magazynie (sprzedaną) z tą umową; kwota umowy = cena zakupu.</p>}
      {saleLabel && pickVariantStore !== null && <div className="md:col-span-2"><VariantPick name="variant_id" storeId={pickVariantStore} label="Pozycja nie jest powiązana z katalogiem – wybierz produkt i rozmiar" /></div>}
      <div>
        <label className="label" htmlFor="type">Typ</label>
        <select className="input" id="type" name="type" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="purchase">umowa kupna</option>
          <option value="consignment">umowa komisowa</option>
          <option value="invoice">FV zakupu</option>
          <option value="other">inna</option>
        </select>
      </div>
      <div>
        <label className="label" htmlFor="vat_form">Forma VAT</label>
        <select className="input" id="vat_form" name="vat_form" defaultValue="vat_margin">
          <option value="vat_margin">FV marża – tylko do rzeczy z VAT marża</option>
          <option value="vat_23">FV 23% – tylko do rzeczy z 23%</option>
          <option value="">bez określenia</option>
        </select>
      </div>
      <div>
        <label className="label" htmlFor="contract_date">Data</label>
        <DateField id="contract_date" name="contract_date" defaultValue={new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" })} />
      </div>
      <div>
        <label className="label" htmlFor="currency">Waluta</label>
        <select className="input" id="currency" name="currency" defaultValue="PLN">
          <option value="PLN">PLN</option>
          <option value="EUR">EUR</option>
        </select>
      </div>
      <div>
        <label className="label" htmlFor="doc_number">Nazwa / numer umowy (do JPK)</label>
        <input className="input font-mono" id="doc_number" name="doc_number" placeholder="np. NR00512" maxLength={60} />
        <p className="mt-1 text-xs text-muted">Puste – odczytamy z pliku PDF (skan-zdjęcie bez tekstu trzeba wpisać).</p>
      </div>
      <div>
        <label className="label" htmlFor="counterparty">Od kogo (imię i nazwisko / firma)</label>
        <input className="input" id="counterparty" name="counterparty" required />
      </div>
      {type === "consignment" && (
        <div className="md:col-span-2">
          <label className="label" htmlFor="consignor_id">Komisant</label>
          <select className="input" id="consignor_id" name="consignor_id" defaultValue="">
            <option value="">Wybierz…</option>
            {consignors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
      )}
      {canSeePrices && (
        <div>
          <label className="label" htmlFor="amount">Kwota</label>
          <input className="input" id="amount" name="amount" inputMode="decimal" />
          <label className="mt-1.5 flex items-start gap-2 text-xs text-muted">
            <input type="checkbox" name="amount_per_item" value="1" className="mt-0.5" />
            <span>Kwota za <b>każdą rzecz</b> (np. faktura: każda przypięta rzecz kosztowała tyle samo). Bez zaznaczenia – kwota za całą umowę.</span>
          </label>
        </div>
      )}
      <ContractFileInput label="Plik (PDF lub zdjęcie)" />
      <ContractItemsPicker defaultCodes={defaultUnits.split(/[\s,]+/).filter(Boolean)} />
      <InvoiceItemsInput canSeePrices={canSeePrices} />
      {!saleId && locations.length > 0 && <StockOption locations={locations} canStock={canStock} />}
      <div className="md:col-span-2">
        <label className="label" htmlFor="notes">Notatki</label>
        <input className="input" id="notes" name="notes" />
      </div>
      {state?.error && <p className="text-sm text-bad md:col-span-2">{state.error}</p>}
      <div className="md:col-span-2"><button className="btn" disabled={pending}>{pending ? "Zapisuję…" : "Zapisz umowę"}</button></div>
    </form>
  );
}

/** Ile jednakowych umów z tym samym plikiem utworzyć (rzeczy trafią tylko do pierwszej). */
function CopiesCounter() {
  const [n, setN] = useState(1);
  const set = (v: number) => setN(Math.min(50, Math.max(1, Math.floor(v) || 1)));
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-slate-50 p-3 md:col-span-2">
      <span className="text-sm font-medium">Ile takich samych umów utworzyć?</span>
      <span className="inline-flex items-center rounded-lg border border-line bg-white">
        <button type="button" className="h-9 w-9 text-lg text-muted hover:text-ink" onClick={() => set(n - 1)} aria-label="Mniej">−</button>
        <input name="copies" value={n} onChange={(e) => set(Number(e.target.value))} inputMode="numeric" aria-label="Liczba umów" className="h-9 w-12 border-x border-line text-center tabular-nums outline-none" />
        <button type="button" className="h-9 w-9 text-lg text-muted hover:text-ink" onClick={() => set(n + 1)} aria-label="Więcej">+</button>
      </span>
      <span className="text-xs text-muted">{n > 1 ? `Powstanie ${n} umów z tym samym plikiem i danymi. Rzeczy wybrane niżej trafią tylko do pierwszej.` : "Jedna umowa."}</span>
    </div>
  );
}

/** Rzeczy wpisane ręcznie i spoza katalogu → od razu sztuki na stanie, „nieprzypisane do Shopify”. */
export function StockOption({ locations, compact = false, canStock = false }: { locations: { id: string; label: string }[]; compact?: boolean; canStock?: boolean }) {
  const [on, setOn] = useState(true);
  return (
    <div className={compact ? "flex flex-wrap items-center gap-2 text-sm" : "space-y-2 rounded-xl border border-line p-3 md:col-span-2"}>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="to_stock" value="1" checked={on} onChange={(e) => setOn(e.target.checked)} className="mt-0.5" />
        {compact
          ? <span>dodaj do magazynu („nieprzypisane do Shopify”)</span>
          : <span><b>Rzeczy wpisane ręcznie i spoza katalogu Shopify – dodaj do magazynu</b> <span className="text-muted">(status „nieprzypisane do Shopify”; domyślnie w drodze – przyjmiesz je w Przyjęcie dostawy → W drodze; gdy produkt pojawi się w Shopify, połączysz go w Do zrobienia)</span></span>}
      </label>
      {on && (
        <div className="flex flex-wrap items-center gap-2">
          {/* „Od razu na stan” – tylko administrator; pracownik zawsze „w drodze”. */}
          {canStock ? (
            <select className="input w-auto" name="stock_status" defaultValue="in_transit" aria-label="Status nowych sztuk">
              <option value="in_transit">w drodze (przyjmiesz w W drodze)</option>
              <option value="in_stock">od razu na stan – towar już jest</option>
            </select>
          ) : <span className="text-xs text-muted">w drodze – przyjmiesz w Przyjęcie dostawy → W drodze</span>}
          <select className={compact ? "input w-64" : "input sm:w-80"} name="stock_location_id" defaultValue={locations[0]?.id} aria-label="Lokalizacja dla nowych sztuk">
            {locations.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
        </div>
      )}
    </div>
  );
}
