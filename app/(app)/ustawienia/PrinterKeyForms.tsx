"use client";

import { useActionState, useState } from "react";
import { addPrinter, regeneratePrinterKey, type PrinterKeyState } from "./fiscal-actions";

function KeyBox({ state }: { state: PrinterKeyState }) {
  const [copied, setCopied] = useState(false);
  if (!state?.token) return state?.error ? <p className="text-sm text-bad" role="alert">{state.error}</p> : null;
  return (
    <div className="space-y-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm">
      <p><b>Klucz drukarki „{state.name}”</b> – skopiuj go teraz i wklej przy instalacji programu na komputerze przy drukarce. Później nie będzie widoczny.</p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded-lg border border-emerald-200 bg-white px-2 py-1.5 font-mono text-xs">{state.token}</code>
        <button type="button" className="btn-secondary" onClick={() => { navigator.clipboard.writeText(state.token!); setCopied(true); }}>{copied ? "Skopiowano ✓" : "Kopiuj"}</button>
      </div>
    </div>
  );
}

export function AddPrinterForm() {
  const [state, action, pending] = useActionState<PrinterKeyState, FormData>(addPrinter, null);
  return (
    <div className="space-y-3">
      <form action={action} className="flex flex-wrap items-end gap-2">
        <div className="w-72"><label className="label" htmlFor="printer-name">Nazwa drukarki</label><input id="printer-name" className="input" name="name" placeholder="np. Kasa Poznań – Elzab" required /></div>
        <button className="btn" disabled={pending}>{pending ? "Dodaję…" : "Dodaj drukarkę"}</button>
      </form>
      <KeyBox state={state} />
    </div>
  );
}

export function RegenerateKeyForm({ id }: { id: string }) {
  const [state, action, pending] = useActionState<PrinterKeyState, FormData>(regeneratePrinterKey, null);
  return (
    <div className="space-y-2">
      <form action={action} onSubmit={(e) => { if (!confirm("Wygenerować nowy klucz? Stary przestanie działać – trzeba będzie ponownie zainstalować program.")) e.preventDefault(); }}>
        <input type="hidden" name="id" value={id} />
        <button className="btn-ghost h-8 px-2 text-xs" disabled={pending}>Nowy klucz</button>
      </form>
      <KeyBox state={state} />
    </div>
  );
}
