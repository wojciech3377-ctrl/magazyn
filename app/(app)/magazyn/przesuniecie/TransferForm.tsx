"use client";

import { useActionState, useRef, useState } from "react";
import { createTransfer, lookupTransferUnit, type TransferState, type TransferUnit } from "./actions";

type Loc = { id: string; label: string };

/** Wysyłka na inny magazyn: skąd → dokąd, skan kodów, potem „Wydrukuj listę” (lista do paczki). */
export function TransferForm({ locations, defaultFrom }: { locations: Loc[]; defaultFrom: string }) {
  const [state, action, pending] = useActionState<TransferState, FormData>(createTransfer, null);
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState("");
  const [units, setUnits] = useState<TransferUnit[]>([]);
  const [scan, setScan] = useState("");
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function add() {
    const code = scan.trim();
    if (!code || busy) return;
    setBusy(true);
    const r = await lookupTransferUnit(from, code, units.map((u) => u.id));
    setBusy(false);
    setScan("");
    if ("error" in r) setMsg({ text: r.error, ok: false });
    else {
      setUnits((x) => [r, ...x]);
      setMsg({ text: `Dodano: ${r.code} · ${r.title} ${r.option}`, ok: true });
    }
    input.current?.focus();
  }

  return (
    <form action={action} className="space-y-4">
      <div className="card grid gap-3 p-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="tr-from">Wysyłam z magazynu</label>
          <select id="tr-from" className="input" name="from" value={from} disabled={units.length > 0} onChange={(e) => setFrom(e.target.value)}>
            <option value="">wybierz…</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
          {units.length > 0 && <input type="hidden" name="from" value={from} />}
          {units.length > 0 && <p className="mt-1 text-xs text-muted">Żeby zmienić magazyn źródłowy, usuń zeskanowane rzeczy.</p>}
        </div>
        <div>
          <label className="label" htmlFor="tr-to">Do magazynu</label>
          <select id="tr-to" className="input" name="to" value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">wybierz…</option>
            {locations.filter((l) => l.id !== from).map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
        </div>
      </div>

      <div className="card space-y-3 p-4">
        <label className="label" htmlFor="tr-scan">Zeskanuj albo wpisz kod (kod sztuki, IMEI, SKU, EAN) i Enter</label>
        <div className="flex gap-2">
          <input id="tr-scan" ref={input} className="input max-w-md font-mono" value={scan} disabled={!from} autoFocus autoComplete="off"
            onChange={(e) => setScan(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void add(); } }}
            placeholder={from ? "np. S000123" : "najpierw wybierz magazyn źródłowy"} />
          <button type="button" className="btn-secondary" onClick={add} disabled={!from || busy}>{busy ? "Szukam…" : "Dodaj"}</button>
        </div>
        {msg && <p className={`text-sm ${msg.ok ? "text-ok" : "text-bad"}`} role="status">{msg.text}</p>}
        <div className="overflow-x-auto">
          <table className="table">
            <thead><tr><th>#</th><th>Kod</th><th>Rzecz</th><th>Rozmiar</th><th>Półka</th><th /></tr></thead>
            <tbody>
              {!units.length && <tr><td colSpan={6} className="py-6 text-center text-muted">Zeskanowane rzeczy pojawią się tutaj.</td></tr>}
              {units.map((u, i) => (
                <tr key={u.id}>
                  <td className="text-muted tabular-nums">{units.length - i}</td>
                  <td className="font-mono text-xs">{u.code}<input type="hidden" name="unit" value={u.id} /></td>
                  <td>{u.title}</td>
                  <td className="font-medium">{u.option}</td>
                  <td className="text-sm text-muted">{u.shelf ?? "–"}</td>
                  <td><button type="button" className="text-bad" onClick={() => setUnits((x) => x.filter((y) => y.id !== u.id))} aria-label={`Usuń ${u.code}`}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <input className="input" name="note" placeholder="Uwagi do przesunięcia (opcjonalnie, np. numer paczki)" maxLength={300} />
      </div>

      {state?.error && <p className="text-sm text-bad" role="alert">{state.error}</p>}
      {units.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <button className="btn" disabled={pending || !to}>{pending ? "Zapisuję…" : `Wydrukuj listę (${units.length} szt.)`}</button>
          <span className="text-sm text-muted">{to ? "Rzeczy dostaną status „w drodze” (−1 w Shopify w tym magazynie) i pojawią się w Przyjęciu dostawy → W drodze." : "Wybierz magazyn docelowy."}</span>
        </div>
      )}
    </form>
  );
}
