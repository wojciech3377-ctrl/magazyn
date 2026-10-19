"use client";

import { useState } from "react";

/** Tak / Nie / Oferta przy rzeczy komisanta – kwotę oferty można wpisać dopiero po wybraniu „Oferta”. */
export function IntakeDecisionCells({ id }: { id: string }) {
  const [d, setD] = useState<"" | "yes" | "no" | "offer">("");
  const opt = (v: "yes" | "no" | "offer", label: string, on: string) => (
    <label className={`inline-flex cursor-pointer items-center gap-1 rounded-md border px-2.5 py-1 text-sm transition-colors hover:bg-panel ${d === v ? on : "border-line"}`}>
      <input type="radio" name={`d_${id}`} value={v} checked={d === v} onChange={() => setD(v)} required /> {label}
    </label>
  );
  return (
    <>
      <td className="whitespace-nowrap">
        <span className="flex gap-1.5">
          {opt("yes", "Tak", "border-ok bg-emerald-50 text-ok")}
          {opt("no", "Nie", "border-bad bg-rose-50 text-bad")}
          {opt("offer", "Oferta", "border-accent bg-sky-50 text-accent")}
        </span>
      </td>
      <td className="w-36">
        <input className="input disabled:cursor-not-allowed disabled:bg-panel" name={`o_${id}`} inputMode="decimal" disabled={d !== "offer"} required={d === "offer"}
          placeholder={d === "offer" ? "Twoja kwota" : "najpierw „Oferta”"} aria-label="Kwota oferty" autoFocus={d === "offer"} />
      </td>
    </>
  );
}

type Item = { title: string; option: string; qty: number; price: number; unassigned: boolean };
type Loc = { id: string; label: string };

/** Umowa podpisana: Tak (zatwierdź), Nie (odrzuć) albo Oferta – dopiero wtedy pola z nowymi cenami. */
export function ContractDecision({ id, back, items, showPrices, locations, needsLocation, accept, reject, offer, currency, allowOffer = true }: {
  id: string; back: string; items: Item[]; showPrices: boolean; locations: Loc[]; needsLocation: boolean;
  /** Waluta umowy (PLN / EUR); brak – PLN. */
  currency?: string | null;
  /** Faktura sprzedającego – bez oferty (faktura ma już kwoty). */
  allowOffer?: boolean;
  accept: (fd: FormData) => Promise<void>; reject: (fd: FormData) => Promise<void>; offer: (fd: FormData) => Promise<void>;
}) {
  const [offerMode, setOfferMode] = useState(false);
  const locSelect = (form?: string) => needsLocation ? (
    <select className="input w-56" name="location_id" form={form} aria-label="Dokąd przyjdzie towar">
      {locations.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
    </select>
  ) : null;
  return (
    <div className="space-y-3">
      <form action={offer} id={`oferta-${id}`}>
        <input type="hidden" name="id" value={id} />
        <div className="overflow-x-auto">
          <table className="table">
            <thead><tr><th>Pozycja</th><th>Rozmiar</th><th className="text-right">Ilość</th>{showPrices && <th className="text-right">Cena sprzedającego</th>}{offerMode && <th>Twoja oferta ({currency || "PLN"})</th>}</tr></thead>
            <tbody>
              {items.map((it, idx) => (
                <tr key={idx}>
                  <td>{it.title}{it.unassigned && <span className="ml-1 text-xs text-warn">(do przypisania do katalogu)</span>}</td>
                  <td className="font-medium">{it.option}</td>
                  <td className="text-right">{it.qty}</td>
                  {showPrices && <td className="text-right tabular-nums">{new Intl.NumberFormat("pl-PL", { style: "currency", currency: currency || "PLN" }).format(it.price)}</td>}
                  {offerMode && <td className="w-36"><input className="input" name={`p_${idx}`} inputMode="decimal" defaultValue={showPrices ? String(it.price) : ""} aria-label="Nowa cena" autoFocus={idx === 0} /></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </form>
      {!offerMode ? (
        <div className="flex flex-wrap items-end gap-2">
          <form action={accept} className="flex items-end gap-2">
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="back" value={back} />
            {locSelect()}
            <button className="btn">Tak – zatwierdź</button>
          </form>
          <form action={reject}>
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="back" value={back} />
            <button className="btn-danger">Nie – odrzuć</button>
          </form>
          {allowOffer && <button type="button" className="btn-secondary border-accent text-accent hover:bg-sky-50" onClick={() => setOfferMode(true)}>Oferta – zaproponuj inne ceny</button>}
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-2 rounded-lg border border-accent/40 bg-sky-50 p-3">
          {locSelect(`oferta-${id}`)}
          <input className="input w-72" name="note" form={`oferta-${id}`} placeholder="Wiadomość do sprzedającego (opcjonalnie)" maxLength={500} />
          <button className="btn" form={`oferta-${id}`}>Wyślij ofertę</button>
          <button type="button" className="btn-secondary" onClick={() => setOfferMode(false)}>Anuluj</button>
          <span className="w-full text-xs text-muted">Sprzedający dostanie e-mail z nowymi cenami i linkiem do akceptacji (z ponownym podpisem) albo odrzucenia.</span>
        </div>
      )}
    </div>
  );
}
