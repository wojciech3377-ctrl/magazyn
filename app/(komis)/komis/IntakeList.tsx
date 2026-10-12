"use client";

import { useActionState } from "react";
import { addIntakeTracking, cancelIntake, respondIntakeOffer, type IntakeState } from "./intake-actions";

type Item = { id: string; title: string; option: string | null; form: string; proposed: number; offer: number | null; final: number | null; status: string; statusText: string };
export type IntakeCard = {
  id: string; status: string; statusText: string; tone: string; created: string; location: string; address: string | null;
  tracking: string | null; carrier: string | null; items: Item[];
};

const pln = (n: number | null) => (n === null ? "–" : new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN" }).format(n));
const TONE: Record<string, string> = { amber: "bg-amber-100 text-amber-800", blue: "bg-sky-100 text-sky-800", green: "bg-emerald-100 text-emerald-800", slate: "bg-slate-100 text-slate-700", red: "bg-rose-100 text-bad" };

/** Zgłoszenia komisanta: odpowiedź na oferty, numer przesyłki, stan paczki. */
export function IntakeList({ intakes }: { intakes: IntakeCard[] }) {
  if (!intakes.length) return <p className="text-sm text-muted">Nie masz jeszcze zgłoszeń.</p>;
  return <div className="space-y-4">{intakes.map((i) => <Card key={i.id} i={i} />)}</div>;
}

function Card({ i }: { i: IntakeCard }) {
  const [offerState, offerAction, offerPending] = useActionState<IntakeState, FormData>(respondIntakeOffer, null);
  const [trackState, trackAction, trackPending] = useActionState<IntakeState, FormData>(addIntakeTracking, null);
  const toSend = i.items.filter((x) => x.status === "accepted" || x.status === "received" || x.status === "missing");
  return (
    <div className="card space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <b>Zgłoszenie z {i.created}</b>
        <span className={`rounded px-1.5 py-0.5 text-xs ${TONE[i.tone] ?? ""}`}>{i.statusText}</span>
        <span className="text-sm text-muted">na {i.location}</span>
        {["review", "offer", "to_send"].includes(i.status) && (
          <form action={cancelIntake} className="ml-auto"><input type="hidden" name="intake_id" value={i.id} /><button className="text-sm text-bad hover:underline">Wycofaj zgłoszenie</button></form>
        )}
      </div>

      <form action={offerAction}>
        <input type="hidden" name="intake_id" value={i.id} />
        <div className="overflow-x-auto">
          <table className="table mtable mtable-flow">
            <thead><tr><th>Rzecz</th><th className="text-right">Twoja kwota</th><th className="text-right">Nasza oferta</th><th>Status</th></tr></thead>
            <tbody>
              {i.items.map((x) => (
                <tr key={x.id}>
                  <td>{x.title}{x.option ? <> · <b>{x.option}</b></> : null}<span className="block text-xs text-muted">{x.form}</span></td>
                  <td className="text-right tabular-nums">{pln(x.proposed)}</td>
                  <td className="text-right tabular-nums">{x.offer !== null ? <b>{pln(x.offer)}</b> : "–"}</td>
                  <td className="text-sm">
                    {x.status === "offered" ? (
                      <span className="flex flex-wrap gap-3">
                        <label className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-line px-2.5 py-1 transition-colors hover:bg-panel hover:border-ok has-[:checked]:border-ok has-[:checked]:bg-emerald-50 has-[:checked]:text-ok"><input type="radio" name={`odp_${x.id}`} value="accept" required /> akceptuję</label>
                        <label className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-line px-2.5 py-1 transition-colors hover:bg-panel hover:border-bad has-[:checked]:border-bad has-[:checked]:bg-rose-50 has-[:checked]:text-bad"><input type="radio" name={`odp_${x.id}`} value="decline" /> odmawiam</label>
                      </span>
                    ) : x.statusText}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {i.status === "offer" && (
          <div className="mt-2 space-y-1">
            <p className="text-sm">Zaproponowaliśmy inne kwoty. Zaznacz przy każdej rzeczy, czy akceptujesz – rzeczy zaakceptowane wyślesz do nas.</p>
            {offerState?.error && <p className="text-sm text-bad" role="alert">{offerState.error}</p>}
            <button className="btn" disabled={offerPending}>{offerPending ? "Zapisuję…" : "Wyślij odpowiedź"}</button>
          </div>
        )}
        {offerState?.ok && <p className="mt-2 text-sm font-medium text-ok" role="status">{offerState.ok}</p>}
      </form>

      {(i.status === "to_send" || i.status === "sent") && (
        <div className="space-y-2 rounded-lg border border-line bg-panel/50 p-3">
          <h3 className="font-medium">Paczka do nas ({toSend.length} szt.)</h3>
          <p className="text-sm">Wyślij na adres: <b>{i.location}</b>{i.address ? <span className="block whitespace-pre-line text-muted">{i.address}</span> : null}</p>
          <form action={trackAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="intake_id" value={i.id} />
            <input className="input w-60" name="tracking" defaultValue={i.tracking ?? ""} placeholder="Numer przesyłki" aria-label="Numer przesyłki" required />
            <input className="input w-44" name="carrier" defaultValue={i.carrier ?? ""} placeholder="Przewoźnik (np. InPost)" aria-label="Przewoźnik" />
            <button className="btn" disabled={trackPending}>{trackPending ? "Zapisuję…" : i.tracking ? "Zmień numer" : "Zapisz numer przesyłki"}</button>
          </form>
          {trackState?.error && <p className="text-sm text-bad" role="alert">{trackState.error}</p>}
          {trackState?.ok && <p className="text-sm font-medium text-ok" role="status">{trackState.ok}</p>}
        </div>
      )}
      {i.status === "received" && i.tracking && <p className="text-sm text-muted">Przesyłka {i.tracking}</p>}
    </div>
  );
}
