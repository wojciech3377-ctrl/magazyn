"use client";

import { useActionState, useState } from "react";
import { createContract } from "./actions";
import { ContractFileInput } from "@/components/ContractFileInput";

export function ContractForm({ consignors, defaultUnits, canSeePrices, returnTo = "" }: { consignors: { id: string; name: string }[]; defaultUnits: string; canSeePrices: boolean; returnTo?: string }) {
  const [state, action, pending] = useActionState(createContract, null);
  const [type, setType] = useState("purchase");
  return (
    <form action={action} className="card grid max-w-2xl gap-3 p-4 md:grid-cols-2">
      <input type="hidden" name="returnTo" value={returnTo} />
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
        <input className="input" type="date" id="contract_date" name="contract_date" defaultValue={new Date().toISOString().slice(0, 10)} />
      </div>
      <div>
        <label className="label" htmlFor="currency">Waluta</label>
        <select className="input" id="currency" name="currency" defaultValue="PLN">
          <option value="PLN">PLN</option>
          <option value="EUR">EUR</option>
        </select>
      </div>
      <div className="md:col-span-2">
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
          <label className="label" htmlFor="amount">Kwota (zł)</label>
          <input className="input" id="amount" name="amount" inputMode="decimal" />
        </div>
      )}
      <ContractFileInput label="Plik (PDF lub zdjęcie)" />
      <div className="md:col-span-2">
        <label className="label" htmlFor="units">Sztuki (kody S000123 lub IMEI, oddzielone spacją lub w liniach)</label>
        <textarea className="input font-mono" id="units" name="units" rows={3} defaultValue={defaultUnits} />
      </div>
      <div className="md:col-span-2">
        <label className="label" htmlFor="notes">Notatki</label>
        <input className="input" id="notes" name="notes" />
      </div>
      {state?.error && <p className="text-sm text-bad md:col-span-2">{state.error}</p>}
      <div className="md:col-span-2"><button className="btn" disabled={pending}>{pending ? "Zapisuję…" : "Zapisz umowę"}</button></div>
    </form>
  );
}
