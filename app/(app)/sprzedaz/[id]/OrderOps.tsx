"use client";

import { useActionState, useState } from "react";
import { cancelOrderAction, returnOrderAction, type OrderOpState } from "./actions";

type Line = { id: string; title: string; variant_title: string | null; quantity: number };

const REASONS: [string, string][] = [
  ["CUSTOMER", "Klient zrezygnował"],
  ["INVENTORY", "Brak towaru"],
  ["DECLINED", "Płatność odrzucona"],
  ["FRAUD", "Podejrzenie oszustwa"],
  ["STAFF", "Błąd obsługi"],
  ["OTHER", "Inny powód"],
];

function Result({ state }: { state: OrderOpState }) {
  if (!state) return null;
  return (
    <div className="space-y-1 text-sm" role="status">
      {state.error && <p className="text-bad">{state.error}</p>}
      {state.ok && <p className="font-medium text-ok">{state.ok}</p>}
      {state.notes?.map((n, i) => <p key={i} className="text-warn">{n}</p>)}
    </div>
  );
}

function UnitsChoice() {
  return (
    <fieldset className="space-y-1 text-sm">
      <legend className="label mb-1">Sztuki z magazynu</legend>
      <label className="flex items-center gap-2"><input type="radio" name="units" value="stock" defaultChecked /> wracają na stan (+1 w Base, znów do sprzedania)</label>
      <label className="flex items-center gap-2"><input type="radio" name="units" value="check" /> do sprawdzenia (status „zwrot”, bez zmiany w Base)</label>
    </fieldset>
  );
}

/** Anulowanie i zwrot zamówienia (tylko administrator). */
export function OrderOps({ orderId, lines, paid, hasLabels, canCancel, canReturn }: {
  orderId: string; lines: Line[]; paid: boolean; hasLabels: boolean; canCancel: boolean; canReturn: boolean;
}) {
  const [open, setOpen] = useState<"cancel" | "return" | null>(null);
  const [cancelState, cancelAction, cancelPending] = useActionState<OrderOpState, FormData>(cancelOrderAction, null);
  const [returnState, returnAction, returnPending] = useActionState<OrderOpState, FormData>(returnOrderAction, null);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {canCancel && <button type="button" className={open === "cancel" ? "btn-danger" : "btn-secondary"} onClick={() => setOpen(open === "cancel" ? null : "cancel")}>Anuluj zamówienie</button>}
        {canReturn && <button type="button" className={open === "return" ? "btn" : "btn-secondary"} onClick={() => setOpen(open === "return" ? null : "return")}>Zwrot</button>}
      </div>

      {open === "cancel" && (
        cancelState?.ok ? <Result state={cancelState} /> : (
          <form action={cancelAction} className="space-y-3 rounded-md border border-rose-200 bg-rose-50/40 p-3">
            <input type="hidden" name="order_id" value={orderId} />
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="reason">Powód</label>
                <select id="reason" className="input" name="reason" defaultValue="CUSTOMER">
                  {REASONS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
              <div><label className="label" htmlFor="c-note">Notatka wewnętrzna</label><input id="c-note" className="input" name="note" maxLength={255} /></div>
            </div>
            <div className="flex flex-col gap-1.5 text-sm">
              <label className="flex items-center gap-2"><input type="checkbox" name="refund" defaultChecked={paid} /> Zwróć pieniądze klientowi (na oryginalną metodę płatności)</label>
              <label className="flex items-center gap-2"><input type="checkbox" name="notify" defaultChecked /> Wyślij klientowi e-mail o anulowaniu</label>
              {hasLabels && <label className="flex items-center gap-2"><input type="checkbox" name="cancel_labels" defaultChecked /> Anuluj nieodebraną etykietę w Furgonetce</label>}
            </div>
            <UnitsChoice />
            <Result state={cancelState} />
            <button className="btn-danger" disabled={cancelPending}>{cancelPending ? "Anuluję…" : "Anuluj zamówienie – tego nie da się cofnąć"}</button>
          </form>
        )
      )}

      {open === "return" && (
        returnState?.ok ? <Result state={returnState} /> : (
          <form action={returnAction} className="space-y-3 rounded-md border border-line bg-panel/60 p-3">
            <input type="hidden" name="order_id" value={orderId} />
            <div>
              <div className="label mb-1">Co wraca</div>
              <ul className="space-y-1.5">
                {lines.map((l) => (
                  <li key={l.id} className="flex items-center gap-3 text-sm">
                    <select className="input w-20 py-1" name={`qty_${l.id}`} defaultValue={lines.length === 1 ? String(l.quantity) : "0"} aria-label={`Ilość: ${l.title}`}>
                      {Array.from({ length: l.quantity + 1 }, (_, i) => <option key={i} value={i}>{i}</option>)}
                    </select>
                    <span>{l.title} · <b>{l.variant_title ?? "–"}</b> <span className="text-muted">(z {l.quantity})</span></span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex flex-col gap-1.5 text-sm">
              <label className="flex items-center gap-2"><input type="checkbox" name="refund" defaultChecked={paid} /> Zwróć pieniądze za te pozycje (kwotę liczy Shopify)</label>
              <label className="flex items-center gap-2"><input type="checkbox" name="shipping" /> Zwróć też koszt wysyłki</label>
              <label className="flex items-center gap-2"><input type="checkbox" name="notify" defaultChecked /> Wyślij klientowi e-mail o zwrocie</label>
            </div>
            <UnitsChoice />
            <div><input className="input" name="note" placeholder="Notatka do zwrotu (opcjonalnie)" aria-label="Notatka do zwrotu" /></div>
            <Result state={returnState} />
            <button className="btn" disabled={returnPending}>{returnPending ? "Zapisuję zwrot…" : "Zapisz zwrot"}</button>
          </form>
        )
      )}
    </div>
  );
}
