"use client";

import { useState } from "react";
import { SubmitButton } from "@/components/SubmitButton";
import { saveLineOverride } from "./actions";

/**
 * Pozycja zamówienia na paragonie / fakturze: nazwa i stawka VAT (z możliwością zmiany tylko w tym zamówieniu).
 * Zmiana działa na kolejne dokumenty (paragon, paragon PDF, faktura) – wydrukowanego paragonu nie zmienia.
 */
export function LineDocEdit({ orderId, lineId, name, vats, defaultName, override }: {
  orderId: string; lineId: string; name: string; vats: ("23" | "margin" | "check")[]; defaultName: string;
  override: { name?: string | null; vat?: "23" | "margin" | null } | null;
}) {
  const [edit, setEdit] = useState(false);
  const label = (v: string) => (v === "23" ? "VAT 23%" : v === "margin" ? "VAT marża" : "VAT marża – sprawdź (brak sztuki)");
  const tone = (v: string) => (v === "23" ? "bg-sky-50 text-sky-800 border-sky-200" : v === "margin" ? "bg-emerald-50 text-emerald-800 border-emerald-200" : "bg-amber-50 text-amber-800 border-amber-200");
  if (!edit) {
    return (
      <div className="min-w-44 text-xs">
        {name !== defaultName && <div className="font-medium text-ink">„{name}”</div>}
        <div className="mt-0.5 flex flex-wrap items-center gap-1">
          {[...new Set(vats)].map((v) => <span key={v} className={`rounded border px-1.5 py-0.5 font-medium ${tone(v)}`}>{label(v)}</span>)}
          <button type="button" className="text-accent underline" onClick={() => setEdit(true)}>zmień</button>
        </div>
        {(override?.name || override?.vat) && <div className="mt-0.5 text-muted">zmienione w zamówieniu</div>}
      </div>
    );
  }
  return (
    <form action={saveLineOverride} className="min-w-64 space-y-1.5 text-xs">
      <input type="hidden" name="order_id" value={orderId} />
      <input type="hidden" name="line_id" value={lineId} />
      <input className="input h-8 w-full text-sm" name="name" defaultValue={override?.name ?? ""} placeholder={defaultName} maxLength={120} aria-label="Nazwa na paragonie / fakturze" />
      <select className="input h-8 w-full text-sm" name="vat" defaultValue={override?.vat ?? ""} aria-label="Stawka VAT">
        <option value="">stawka automatycznie</option>
        <option value="margin">VAT marża</option>
        <option value="23">VAT 23%</option>
      </select>
      <div className="flex flex-wrap gap-1.5">
        <SubmitButton className="btn h-8 px-2.5 text-xs" pendingText="…">Zapisz</SubmitButton>
        {(override?.name || override?.vat) && <SubmitButton className="btn-secondary h-8 px-2.5 text-xs" name="reset" value="1" pendingText="…">Przywróć</SubmitButton>}
        <button type="button" className="btn-secondary h-8 px-2.5 text-xs" onClick={() => setEdit(false)}>Anuluj</button>
      </div>
      <p className="text-muted">Puste pole nazwy = nazwa z zamówienia. Dotyczy nowych paragonów i faktur do tego zamówienia.</p>
    </form>
  );
}
