"use client";

import { useActionState } from "react";
import { SubmitButton } from "@/components/SubmitButton";
import { addManualTracking, type TrackingState } from "./actions";

const CARRIERS = ["InPost", "DPD", "DHL", "GLS", "UPS", "FedEx", "Poczta Polska", "Orlen Paczka", "Inny"];

/** Numer przesyłki nadanej poza Furgonetką → Shopify (wysłane z numerem) albo przesyłka w aplikacji. */
export function ManualTrackingForm({ orderId }: { orderId: string }) {
  const [state, action] = useActionState<TrackingState, FormData>(addManualTracking, null);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="order_id" value={orderId} />
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_11rem]">
        <input className="input font-mono" name="number" placeholder="numer przesyłki" aria-label="Numer przesyłki" required autoComplete="off" />
        <select className="input" name="carrier" defaultValue="InPost" aria-label="Przewoźnik">
          {CARRIERS.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <input className="input" name="url" type="url" placeholder="link do śledzenia (opcjonalnie – dla znanych przewoźników Shopify utworzy sam)" aria-label="Link do śledzenia" />
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="notify" defaultChecked /> Wyślij klientowi e-mail z numerem przesyłki</label>
      {state?.error && <p className="text-sm text-bad" role="alert">{state.error}</p>}
      {state?.ok && <p className="text-sm font-medium text-ok" role="status">{state.ok}</p>}
      <SubmitButton className="btn-secondary" pendingText="Zapisuję…">Zapisz numer przesyłki</SubmitButton>
    </form>
  );
}
