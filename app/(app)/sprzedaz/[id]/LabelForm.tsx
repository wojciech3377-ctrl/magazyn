"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { createLabel, quoteLabel, type LabelState, type QuoteState } from "./actions";
import { lockerOnly, LOCKER_SIZES, SERVICE_LABEL, toPoint, type ServiceKey } from "@/lib/orders/sender";

const pln = (n: number) => new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN" }).format(n);

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
  const locker = toPoint(service);
  const [size, setSize] = useState<string>("");
  const custom = !lockerOnly(service) && size === "custom";
  const [notify, setNotify] = useState(true);
  const [quote, setQuote] = useState<QuoteState>(null);
  const [quoting, setQuoting] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  // Wycena po każdej zmianie wielkości, wagi, punktu, pobrania i adresu (z opóźnieniem).
  function requote() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      if (!formRef.current) return;
      const fd = new FormData(formRef.current);
      if (!fd.get("size")) return;
      const my = ++seq.current;
      setQuoting(true);
      const q = await quoteLabel(fd).catch(() => null);
      if (my === seq.current) { setQuote(q); setQuoting(false); }
    }, 600);
  }
  useEffect(() => { requote(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [size, service]);
  const priceOf = (k: ServiceKey) => quote?.prices[k];

  if (state?.ok && state.shipmentId) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-ok">{state.ok}{state.tracking && <> Numer przesyłki: <b className="font-mono">{state.tracking}</b></>}</p>
        {state.warning && <p className="text-sm text-warn">{state.warning}</p>}
        <a className="btn" href={`/druk/pdf?src=${encodeURIComponent(`/api/etykiety/${state.shipmentId}`)}&nazwa=etykieta&tytul=${encodeURIComponent("Etykieta wysyłkowa")}`}>Otwórz etykietę (PDF)</a>
      </div>
    );
  }

  return (
    <form ref={formRef} action={action} className="space-y-4" onChange={(e) => { const n = (e.target as HTMLInputElement).name; if (n && !["service", "size", "fulfill", "notify", "description"].includes(n)) requote(); }}>
      <input type="hidden" name="order_id" value={d.orderId} />
      <fieldset className="flex flex-wrap gap-2">
        <legend className="label mb-1">Przewoźnik</legend>
        {(Object.keys(SERVICE_LABEL) as ServiceKey[]).map((k) => {
          const p = priceOf(k);
          return (
            <label key={k} className={`flex min-w-36 cursor-pointer flex-col rounded-md border px-3 py-1.5 text-sm transition-colors ${service === k ? "border-ink bg-ink text-white" : "border-line hover:border-accent hover:bg-sky-50"}`} title={p?.note}>
              <input className="sr-only" type="radio" name="service" value={k} checked={service === k} onChange={() => { setService(k); if (lockerOnly(k) && size === "custom") setSize(""); }} />
              <span className="font-medium">{SERVICE_LABEL[k]}</span>
              <span className={`text-xs ${service === k ? "text-white/80" : "text-muted"}`}>
                {quoting && !p ? "liczę cenę…" : p?.price != null ? pln(p.price) : p?.note ? (p.note.length > 28 ? "cena po uzupełnieniu" : p.note) : size ? "–" : "wybierz wielkość"}
              </span>
            </label>
          );
        })}
      </fieldset>

      {locker && (
        <div className="max-w-md">
          <label className="label" htmlFor="point">{service === "inpost_locker" ? "Paczkomat odbiorcy (InPost)" : service === "dpd_locker" ? "Paczkomat DPD odbiorcy" : "Punkt DPD Pickup odbiorcy"}</label>
          <input id="point" className="input font-mono uppercase" name="point" defaultValue={d.point} placeholder={service === "inpost_locker" ? "np. WAW253M" : "np. PL11033"} required />
          <a className="mt-1 inline-block text-xs text-accent hover:underline" href="https://furgonetka.pl/mapa" target="_blank" rel="noreferrer">Znajdź kod na mapie punktów</a>
        </div>
      )}

      <fieldset>
        <legend className="label mb-1">Wielkość paczki</legend>
        <div className="grid gap-2 sm:grid-cols-4">
          {Object.entries(LOCKER_SIZES).map(([k, v]) => (
            <label key={k} className={`flex cursor-pointer flex-col rounded-lg border-2 p-3 transition-colors hover:border-accent hover:bg-sky-50 ${size === k ? "border-accent bg-sky-50" : "border-line"}`}>
              <input className="sr-only" type="radio" name="size" value={k} checked={size === k} onChange={() => setSize(k)} required />
              <span className="flex items-center gap-2 font-semibold">
                <span className="inline-flex h-7 w-7 items-center justify-center rounded bg-ink text-sm text-white">{k}</span>{v.label}
              </span>
              <span className="mt-1 text-xs text-muted">{v.dims} · do {v.maxKg} kg</span>
            </label>
          ))}
          {!lockerOnly(service) && (
            <label className={`flex cursor-pointer flex-col justify-center rounded-lg border-2 p-3 transition-colors hover:border-accent hover:bg-sky-50 ${size === "custom" ? "border-accent bg-sky-50" : "border-line"}`}>
              <input className="sr-only" type="radio" name="size" value="custom" checked={size === "custom"} onChange={() => setSize("custom")} />
              <span className="font-semibold">Inne wymiary</span>
              <span className="mt-1 text-xs text-muted">wpiszesz sam</span>
            </label>
          )}
        </div>
      </fieldset>
      {custom && (
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
        <label className="flex cursor-pointer items-center gap-3">
          <input type="checkbox" name="notify" className="peer sr-only" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
          <span className="relative inline-flex h-6 w-11 flex-none items-center rounded-full bg-slate-300 transition-colors after:absolute after:left-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:bg-accent peer-checked:after:translate-x-5 peer-focus-visible:ring-2 peer-focus-visible:ring-accent" aria-hidden="true" />
          Wyślij klientowi e-mail ze śledzeniem <span className="text-xs text-muted">({notify ? "włączone" : "wyłączone"})</span>
        </label>
      </div>

      {state?.error && <p className="text-sm text-bad" role="alert">{state.error}</p>}
      <button className="btn" disabled={pending || !size || (lockerOnly(service) && size === "custom")}>{pending ? "Tworzę etykietę…" : `Utwórz etykietę ${SERVICE_LABEL[service]}${priceOf(service)?.price != null ? ` · ${pln(priceOf(service)!.price!)}` : ""}`}</button>
      <p className="text-xs text-muted">Przesyłka zostaje zamówiona w Furgonetce i obciąża konto. {service.startsWith("dpd") ? "Nadanie zawsze w punkcie DPD Pickup (zmienisz w Ustawieniach → Wysyłka)." : "Nadanie zawsze w paczkomacie InPost (zmienisz w Ustawieniach → Wysyłka)."} Ceny brutto z wyceny Furgonetki.</p>
    </form>
  );
}
