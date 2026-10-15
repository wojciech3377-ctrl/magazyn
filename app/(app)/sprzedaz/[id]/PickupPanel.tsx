"use client";

import { useActionState } from "react";
import { pickupAction, type OrderOpState } from "./actions";

/** Odbiór osobisty: „Gotowe do odbioru” (Shopify wysyła klientowi e-mail), potem „Klient odebrał”. */
export function PickupPanel({ orderId, ready }: { orderId: string; ready: boolean }) {
  const [state, action, pending] = useActionState<OrderOpState, FormData>(pickupAction, null);
  return (
    <section className="card mt-5 p-4">
      <h2 className="h2 mb-1">Odbiór osobisty</h2>
      <p className="mb-3 text-sm text-muted">
        {ready
          ? "Klient dostał e-mail „Gotowe do odbioru”. Gdy odbierze zamówienie, oznacz je jako odebrane."
          : "Gdy zamówienie jest spakowane i czeka w sklepie, kliknij „Gotowe do odbioru” – Shopify sam wyśle klientowi e-mail."}
      </p>
      <form action={action} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="id" value={orderId} />
        {!ready && <button className="btn" name="step" value="ready" disabled={pending}>{pending ? "Wysyłam…" : "Gotowe do odbioru (e-mail do klienta)"}</button>}
        <button className={ready ? "btn" : "btn-secondary"} name="step" value="picked" disabled={pending}>Klient odebrał</button>
        {ready && <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-800">gotowe do odbioru ✓</span>}
      </form>
      {state?.error && <p className="mt-2 text-sm text-bad">{state.error}</p>}
      {state?.ok && <p className="mt-2 text-sm text-ok">{state.ok}</p>}
    </section>
  );
}
