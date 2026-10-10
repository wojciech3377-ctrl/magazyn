"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { cancelOrderAction, returnOrderAction, type OrderOpState } from "./actions";

type Line = { id: string; title: string; variant_title: string | null; quantity: number; price: number; refunded: number };

const REASONS: [string, string][] = [
  ["CUSTOMER", "Klient zrezygnował"],
  ["INVENTORY", "Brak towaru"],
  ["DECLINED", "Płatność odrzucona"],
  ["FRAUD", "Podejrzenie oszustwa"],
  ["STAFF", "Błąd obsługi"],
  ["OTHER", "Inny powód"],
];

const pln = (n: number) => new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN" }).format(n);

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

function GoodsChoice({ allowKeep }: { allowKeep: boolean }) {
  return (
    <fieldset className="space-y-1 text-sm">
      <legend className="label mb-1">Towar</legend>
      <label className="flex items-center gap-2"><input type="radio" name="units" value="stock" defaultChecked /> wraca na stan (znów do sprzedania)</label>
      <label className="flex items-center gap-2"><input type="radio" name="units" value="check" /> wraca do sprawdzenia (status „zwrot”)</label>
      {allowKeep && <label className="flex items-center gap-2"><input type="radio" name="units" value="keep" /> zostaje u klienta – tylko zwrot pieniędzy (np. rabat, reklamacja)</label>}
    </fieldset>
  );
}

/** Anulowanie z całkowitym zwrotem i zwrot częściowy z wyborem pozycji / kwoty (tylko administrator). */
export function OrderOps({ orderId, lines, paid, shippingPrice, hasLabels, canCancel, canRefund }: {
  orderId: string; lines: Line[]; paid: boolean; shippingPrice: number; hasLabels: boolean; canCancel: boolean; canRefund: boolean;
}) {
  const [open, setOpen] = useState<"cancel" | "refund" | null>(null);
  const [cancelState, cancelAction, cancelPending] = useActionState<OrderOpState, FormData>(cancelOrderAction, null);
  const [refundState, refundAction, refundPending] = useActionState<OrderOpState, FormData>(returnOrderAction, null);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [ship, setShip] = useState(false);
  const [money, setMoney] = useState(paid);
  const [custom, setCustom] = useState("");
  // Klucz jednego zwrotu: ponowne wysłanie tego samego formularza nie zwróci pieniędzy drugi raz.
  const [nonce, setNonce] = useState(() => crypto.randomUUID());
  useEffect(() => {
    // Zwrot na pewno się nie wykonał (walidacja / odmowa Shopify) → poprawiony formularz idzie z nowym kluczem.
    if (refundState?.error && /^(Shopify|Wybierz|Kwota|Towar|Do zwrotu|Nie ma)/.test(refundState.error)) setNonce(crypto.randomUUID());
  }, [refundState]);
  const estimate = useMemo(
    () => lines.reduce((s, l) => s + (qty[l.id] ?? 0) * l.price, 0) + (ship ? shippingPrice : 0),
    [lines, qty, ship, shippingPrice],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {canCancel && <button type="button" className={open === "cancel" ? "btn-danger" : "btn-secondary"} onClick={() => setOpen(open === "cancel" ? null : "cancel")}>{paid ? "Anuluj i zwróć środki" : "Anuluj zamówienie"}</button>}
        {canRefund && <button type="button" className={open === "refund" ? "btn" : "btn-secondary"} onClick={() => setOpen(open === "refund" ? null : "refund")}>Zwróć środki częściowo / zwrot towaru</button>}
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
              {paid
                ? <label className="flex items-center gap-2"><input type="checkbox" name="refund" defaultChecked /> Zwróć klientowi całą kwotę (na oryginalną metodę płatności)</label>
                : <p className="text-muted">Zamówienie nie jest opłacone – nie ma czego zwracać.</p>}
              <label className="flex items-center gap-2"><input type="checkbox" name="notify" defaultChecked /> Wyślij klientowi e-mail o anulowaniu</label>
              {hasLabels && <label className="flex items-center gap-2"><input type="checkbox" name="cancel_labels" defaultChecked /> Anuluj nieodebraną etykietę w Furgonetce</label>}
            </div>
            <GoodsChoice allowKeep={false} />
            <Result state={cancelState} />
            <button className="btn-danger" disabled={cancelPending}>{cancelPending ? "Anuluję…" : paid ? "Anuluj i zwróć środki – tego nie da się cofnąć" : "Anuluj zamówienie – tego nie da się cofnąć"}</button>
          </form>
        )
      )}

      {open === "refund" && (
        refundState?.ok ? <Result state={refundState} /> : (
          <form action={refundAction} className="space-y-3 rounded-md border border-line bg-panel/60 p-3">
            <input type="hidden" name="order_id" value={orderId} />
            <input type="hidden" name="nonce" value={nonce} />
            <div>
              <div className="label mb-1">Za co zwracasz</div>
              <ul className="space-y-1.5">
                {lines.map((l) => {
                  const left = Math.max(0, l.quantity - l.refunded);
                  return (
                    <li key={l.id} className="flex items-center gap-3 text-sm">
                      <select className="input w-20 py-1" name={`qty_${l.id}`} value={qty[l.id] ?? 0} disabled={!left}
                        onChange={(e) => setQty({ ...qty, [l.id]: Number(e.target.value) })} aria-label={`Ilość: ${l.title}`}>
                        {Array.from({ length: left + 1 }, (_, i) => <option key={i} value={i}>{i}</option>)}
                      </select>
                      <span className="flex-1">{l.title} · <b>{l.variant_title ?? "–"}</b> <span className="text-muted">({pln(l.price)}{l.refunded ? ` · zwrócono już ${l.refunded}` : ""})</span></span>
                    </li>
                  );
                })}
              </ul>
              {shippingPrice > 0 && <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" name="shipping" checked={ship} onChange={(e) => setShip(e.target.checked)} /> Koszt wysyłki ({pln(shippingPrice)})</label>}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5 text-sm">
                <label className="flex items-center gap-2"><input type="checkbox" name="refund" checked={money} onChange={(e) => setMoney(e.target.checked)} /> Zwróć pieniądze (na oryginalną metodę płatności)</label>
                <label className="flex items-center gap-2"><input type="checkbox" name="notify" defaultChecked /> Wyślij klientowi e-mail o zwrocie</label>
              </div>
              {money && (
                <div>
                  <label className="label" htmlFor="amount">Kwota zwrotu (zł)</label>
                  <input id="amount" className="input" name="amount" inputMode="decimal" value={custom} onChange={(e) => setCustom(e.target.value)}
                    placeholder={estimate > 0 ? `${estimate.toFixed(2)} – z wybranych pozycji` : "np. 50,00"} />
                  <p className="mt-1 text-xs text-muted">Puste = kwota wybranych pozycji{shippingPrice > 0 ? " i wysyłki" : ""} (liczy Shopify, z rabatami). Wpisz inną, żeby zwrócić część.</p>
                </div>
              )}
            </div>
            <GoodsChoice allowKeep />
            <div><input className="input" name="note" placeholder="Notatka do zwrotu (opcjonalnie)" aria-label="Notatka do zwrotu" /></div>
            <Result state={refundState} />
            <button className="btn" disabled={refundPending}>{refundPending ? "Zapisuję…" : money ? `Zwróć ${custom ? pln(Number(custom.replace(",", ".")) || 0) : estimate > 0 ? pln(estimate) : "środki"}` : "Zapisz zwrot towaru"}</button>
          </form>
        )
      )}
    </div>
  );
}
