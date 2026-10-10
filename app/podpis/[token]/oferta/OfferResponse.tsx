"use client";

import { useActionState, useState } from "react";
import { SignaturePad } from "@/components/SignaturePad";

type Row = { title: string; qty: number; before: string; after: string; changed: boolean };

/** Akceptacja nowych cen (zgoda + podpis) albo odmowa. */
export function OfferResponse({ action, rows, total, note }: { action: (prev: { error?: string } | null, fd: FormData) => Promise<{ error?: string }>; rows: Row[]; total: string; note: string | null }) {
  const [state, formAction, pending] = useActionState(action, null);
  const [decision, setDecision] = useState<"accept" | "decline" | "">("");
  const [signature, setSignature] = useState("");
  const [consent, setConsent] = useState(false);
  return (
    <form action={formAction} className="card mx-auto max-w-2xl space-y-4 p-5">
      <input type="text" name="website" className="hidden" tabIndex={-1} autoComplete="off" />
      <p className="text-sm">Dziękujemy za podpisanie umowy. Po sprawdzeniu proponujemy następujące ceny. / After review we propose the following prices.</p>
      <table className="table">
        <thead><tr><th>Pozycja</th><th className="text-right">Ilość</th><th className="text-right">Było</th><th className="text-right">Proponujemy</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>{r.title}</td>
              <td className="text-right">{r.qty}</td>
              <td className="text-right tabular-nums">{r.changed ? <s className="text-muted">{r.before}</s> : r.before}</td>
              <td className="text-right font-semibold tabular-nums">{r.after}</td>
            </tr>
          ))}
          <tr><td colSpan={3} className="text-right font-medium">Razem / Total</td><td className="text-right font-bold tabular-nums">{total}</td></tr>
        </tbody>
      </table>
      {note && <p className="rounded bg-panel p-2 text-sm">{note}</p>}
      <fieldset className="space-y-2 text-sm">
        <label className="flex items-center gap-2"><input type="radio" name="decision" value="accept" checked={decision === "accept"} onChange={() => setDecision("accept")} /> <b>Akceptuję nowe ceny</b> / I accept</label>
        <label className="flex items-center gap-2"><input type="radio" name="decision" value="decline" checked={decision === "decline"} onChange={() => setDecision("decline")} /> <b>Odrzucam ofertę</b> – umowa nie zostanie zawarta / I decline</label>
      </fieldset>
      {decision === "accept" && (
        <div className="space-y-3">
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="consent" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-1" /> Akceptuję umowę kupna z powyższymi cenami. Pozostałe postanowienia umowy bez zmian. / I accept the agreement with the prices above.</label>
          <SignaturePad label="Podpis sprzedającego / Seller's signature" onChange={setSignature} />
        </div>
      )}
      {state?.error && <p className="text-sm text-bad" role="alert">{state.error}</p>}
      <button className={decision === "decline" ? "btn-danger w-full py-3" : "btn w-full py-3"} disabled={pending || !decision || (decision === "accept" && (!signature || !consent))}>
        {pending ? "Zapisuję…" : decision === "decline" ? "Odrzuć ofertę" : "Akceptuję i podpisuję"}
      </button>
    </form>
  );
}
