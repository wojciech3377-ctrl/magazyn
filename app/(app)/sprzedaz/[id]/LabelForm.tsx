"use client";

import { useActionState, useState } from "react";
import { createLabel, type LabelState } from "./actions";
import { LOCKER_SIZES, SERVICE_LABEL, type ServiceKey } from "@/lib/orders/sender";

export type LabelDefaults = {
  orderId: string;
  service: ServiceKey;
  point: string;
  name: string;
  company: string;
  street: string;
  postcode: string;
  city: string;
  country: string;
  email: string;
  phone: string;
  value: number;
  cod: number;
  description: string;
};

export function LabelForm({ d }: { d: LabelDefaults }) {
  const [state, action, pending] = useActionState<LabelState, FormData>(createLabel, null);
  const [service, setService] = useState<ServiceKey>(d.service);
  const locker = service === "inpost_locker";

  if (state?.ok && state.shipmentId) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-ok">{state.ok}{state.tracking && <> Numer przesyłki: <b className="font-mono">{state.tracking}</b></>}</p>
        {state.warning && <p className="text-sm text-warn">{state.warning}</p>}
        <a className="btn" href={`/api/etykiety/${state.shipmentId}`} target="_blank" rel="noreferrer">Otwórz etykietę (PDF)</a>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="order_id" value={d.orderId} />
      <fieldset className="flex flex-wrap gap-2">
        <legend className="label mb-1">Przewoźnik</legend>
        {(Object.keys(SERVICE_LABEL) as ServiceKey[]).map((k) => (
          <label key={k} className={`cursor-pointer rounded-md border px-3 py-1.5 text-sm ${service === k ? "border-ink bg-ink text-white" : "border-line hover:bg-panel"}`}>
            <input className="sr-only" type="radio" name="service" value={k} checked={service === k} onChange={() => setService(k)} />
            {SERVICE_LABEL[k]}
          </label>
        ))}
      </fieldset>

      {locker ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="point">Paczkomat odbiorcy</label>
            <input id="point" className="input font-mono uppercase" name="point" defaultValue={d.point} placeholder="np. WAW253M" required />
          </div>
          <div>
            <label className="label" htmlFor="size">Gabaryt</label>
            <select id="size" className="input" name="size" defaultValue="B">
              {Object.entries(LOCKER_SIZES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          <div><label className="label" htmlFor="width">Szer. (cm)</label><input id="width" className="input" name="width" inputMode="numeric" defaultValue="25" /></div>
          <div><label className="label" htmlFor="depth">Dł. (cm)</label><input id="depth" className="input" name="depth" inputMode="numeric" defaultValue="35" /></div>
          <div><label className="label" htmlFor="height">Wys. (cm)</label><input id="height" className="input" name="height" inputMode="numeric" defaultValue="15" /></div>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-4">
        <div><label className="label" htmlFor="weight">Waga (kg)</label><input id="weight" className="input" name="weight" inputMode="decimal" defaultValue="1" /></div>
        <div><label className="label" htmlFor="value">Wartość / ubezp. (zł)</label><input id="value" className="input" name="value" inputMode="decimal" defaultValue={d.value ? d.value.toFixed(2) : ""} /></div>
        <div><label className="label" htmlFor="cod">Pobranie (zł)</label><input id="cod" className="input" name="cod" inputMode="decimal" defaultValue={d.cod ? d.cod.toFixed(2) : ""} placeholder="bez pobrania" /></div>
        <div><label className="label" htmlFor="description">Zawartość</label><input id="description" className="input" name="description" defaultValue={d.description} /></div>
      </div>

      <details className="rounded-md border border-line p-3" open={!d.street && !locker}>
        <summary className="cursor-pointer text-sm font-medium">Odbiorca: {d.name || "–"}{d.city ? `, ${d.city}` : ""}</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div><label className="label" htmlFor="name">Imię i nazwisko</label><input id="name" className="input" name="name" defaultValue={d.name} required /></div>
          <div><label className="label" htmlFor="company">Firma</label><input id="company" className="input" name="company" defaultValue={d.company} /></div>
          <div><label className="label" htmlFor="phone">Telefon</label><input id="phone" className="input" name="phone" defaultValue={d.phone} required /></div>
          <div><label className="label" htmlFor="email">E-mail</label><input id="email" className="input" type="email" name="email" defaultValue={d.email} /></div>
          <div className="sm:col-span-2"><label className="label" htmlFor="street">Ulica i numer</label><input id="street" className="input" name="street" defaultValue={d.street} /></div>
          <div><label className="label" htmlFor="postcode">Kod pocztowy</label><input id="postcode" className="input" name="postcode" defaultValue={d.postcode} /></div>
          <div><label className="label" htmlFor="city">Miasto</label><input id="city" className="input" name="city" defaultValue={d.city} /></div>
          <div><label className="label" htmlFor="country_code">Kraj (kod)</label><input id="country_code" className="input uppercase" name="country_code" defaultValue={d.country} maxLength={2} /></div>
        </div>
      </details>

      <div className="flex flex-col gap-1.5 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" name="fulfill" defaultChecked /> Oznacz w Shopify jako wysłane z numerem przesyłki</label>
        <label className="flex items-center gap-2"><input type="checkbox" name="notify" defaultChecked /> Wyślij klientowi e-mail ze śledzeniem</label>
      </div>

      {state?.error && <p className="text-sm text-bad" role="alert">{state.error}</p>}
      <button className="btn" disabled={pending}>{pending ? "Tworzę etykietę…" : `Utwórz etykietę ${SERVICE_LABEL[service]}`}</button>
      <p className="text-xs text-muted">Przesyłka zostaje zamówiona w Furgonetce i obciąża konto. {locker ? "Nadanie w dowolnym paczkomacie (zmienisz w Ustawieniach)." : "Odbiór przez kuriera z adresu nadawcy z Ustawień."}</p>
    </form>
  );
}
