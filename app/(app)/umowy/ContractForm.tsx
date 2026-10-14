"use client";

import { useActionState, useState } from "react";
import { createContract } from "./actions";
import { ContractFileInput } from "@/components/ContractFileInput";
import { VariantPick } from "@/components/VariantPick";
import { ContractItemsPicker } from "./ContractItemsPicker";
import { DateField } from "@/components/DateField";

export function ContractForm({ consignors, defaultUnits, canSeePrices, returnTo = "", saleId = null, saleLabel = null, pickVariantStore = null }: { consignors: { id: string; name: string }[]; defaultUnits: string; canSeePrices: boolean; returnTo?: string; saleId?: string | null; saleLabel?: string | null; pickVariantStore?: string | null }) {
  const [state, action, pending] = useActionState(createContract, null);
  const [type, setType] = useState("purchase");
  return (
    <form action={action} className="card grid max-w-3xl gap-3 p-4 md:grid-cols-2">
      <input type="hidden" name="returnTo" value={returnTo} />
      {saleId && <input type="hidden" name="sale_id" value={saleId} />}
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
      <div className="md:col-span-2">
        <label className="label" htmlFor="notes">Notatki</label>
        <input className="input" id="notes" name="notes" />
      </div>
      {state?.error && <p className="text-sm text-bad md:col-span-2">{state.error}</p>}
      <div className="md:col-span-2"><button className="btn" disabled={pending}>{pending ? "Zapisuję…" : "Zapisz umowę"}</button></div>
    </form>
  );
}
