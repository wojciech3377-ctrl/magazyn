"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { summarizeInventory, type InvSummary } from "./actions";
import { SearchInput } from "@/components/SearchInput";

type Loc = { id: string; label: string };
const KEY = (loc: string) => `inwentaryzacja:${loc}`;

export function InventoryScanner({ locations }: { locations: Loc[] }) {
  const [loc, setLoc] = useState("");
  const [scans, setScans] = useState<string[]>([]);
  const [code, setCode] = useState("");
  const [summary, setSummary] = useState<InvSummary | null>(null);
  const [pending, start] = useTransition();
  const input = useRef<HTMLInputElement>(null);

  // Skany zapamiętane w przeglądarce (odświeżenie strony nie gubi postępu).
  useEffect(() => {
    if (!loc) return;
    try { setScans(JSON.parse(localStorage.getItem(KEY(loc)) ?? "[]")); } catch { setScans([]); }
    setSummary(null);
    setTimeout(() => input.current?.focus(), 50);
  }, [loc]);
  useEffect(() => { if (loc) try { localStorage.setItem(KEY(loc), JSON.stringify(scans)); } catch { /* bez zapisu */ } }, [scans, loc]);

  const add = () => {
    const c = code.trim().toUpperCase();
    if (!c) return;
    setScans((s) => [c, ...s]);
    setCode("");
  };
  const counts = scans.reduce((m, c) => m.set(c, (m.get(c) ?? 0) + 1), new Map<string, number>());

  if (!loc) {
    return (
      <div className="card max-w-xl space-y-3 p-5">
        <label className="label" htmlFor="inv-loc">Lokalizacja</label>
        <select id="inv-loc" className="input" value={loc} onChange={(e) => setLoc(e.target.value)}>
          <option value="">Wybierz…</option>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
        </select>
      </div>
    );
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
      <section className="card space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <b>{locations.find((l) => l.id === loc)?.label}</b>
          <button className="text-sm text-accent hover:underline" onClick={() => setLoc("")}>zmień</button>
          <span className="ml-auto rounded bg-ink px-2 py-1 text-sm font-semibold text-white tabular-nums">{scans.length} zeskanowanych</span>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); add(); }} className="flex gap-2">
          <SearchInput ref={input} large noIcon wrapperClassName="flex-1" className="font-mono" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Skanuj kod…" autoFocus aria-label="Kod kreskowy"
            continuous onScan={(c) => setScans((s) => [c.trim().toUpperCase(), ...s])} />
          <button className="btn h-12">Dodaj</button>
        </form>
        <div className="flex flex-wrap gap-2">
          <button className="btn-secondary" disabled={!scans.length} onClick={() => setScans((s) => s.slice(1))}>Cofnij ostatni</button>
          <button className="btn-secondary text-bad" disabled={!scans.length} onClick={() => { if (confirm("Wyczyścić wszystkie skany tej lokalizacji?")) { setScans([]); setSummary(null); } }}>Zacznij od nowa</button>
          <button className="btn ml-auto" disabled={pending || !scans.length} onClick={() => start(async () => setSummary(await summarizeInventory(loc, scans)))}>
            {pending ? "Liczę…" : "Zakończ i podsumuj"}
          </button>
        </div>
        <ul className="max-h-[50vh] divide-y divide-line overflow-y-auto rounded border border-line font-mono text-sm">
          {scans.map((c, i) => <li key={`${c}-${i}`} className="flex justify-between px-2 py-1"><span>{c}</span>{(counts.get(c) ?? 0) > 1 && <span className="text-xs text-warn">×{counts.get(c)}</span>}</li>)}
          {!scans.length && <li className="px-2 py-4 text-center text-muted">Zeskanuj pierwszą rzecz.</li>}
        </ul>
      </section>

      <section className="card space-y-3 p-4">
        <h2 className="h2">Podsumowanie</h2>
        {!summary && <p className="text-sm text-muted">Po zeskanowaniu wszystkiego kliknij „Zakończ i podsumuj”. Możesz to zrobić kilka razy – skany zostają.</p>}
        {summary && "error" in summary && <p className="text-sm text-bad">{summary.error}</p>}
        {summary && !("error" in summary) && (
          <>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded bg-panel p-2"><div className="text-xs text-muted">W aplikacji</div><div className="text-xl font-semibold">{summary.expected}</div></div>
              <div className="rounded bg-emerald-50 p-2"><div className="text-xs text-muted">Znalezione</div><div className="text-xl font-semibold text-ok">{summary.matched}</div></div>
              <div className="rounded bg-rose-50 p-2"><div className="text-xs text-muted">Brakuje</div><div className="text-xl font-semibold text-bad">{summary.missing.length}</div></div>
            </div>
            <div>
              <h3 className="mb-1 font-medium text-bad">Brakuje na miejscu ({summary.missing.length})</h3>
              <ul className="max-h-72 divide-y divide-line overflow-y-auto text-sm">
                {summary.missing.map((m) => <li key={m.unitId} className="flex gap-2 py-1"><Link className="text-accent hover:underline" href={`/magazyn/${m.unitId}`} target="_blank">{m.title} · <b>{m.option}</b></Link><span className="ml-auto font-mono text-xs text-muted">{m.code}</span></li>)}
                {!summary.missing.length && <li className="py-1 text-ok">Wszystko jest na miejscu.</li>}
              </ul>
            </div>
            <div>
              <h3 className="mb-1 font-medium text-warn">Nadwyżki i nieznane kody ({summary.extra.length})</h3>
              <ul className="max-h-56 divide-y divide-line overflow-y-auto text-sm">
                {summary.extra.map((x, i) => <li key={i} className="flex gap-2 py-1"><span className="font-mono text-xs">{x.scan}</span><span>{x.title}{x.option ? ` · ${x.option}` : ""}</span><span className="ml-auto text-xs text-muted">{x.note}</span></li>)}
                {!summary.extra.length && <li className="py-1 text-muted">Brak.</li>}
              </ul>
            </div>
            <button className="btn-secondary" onClick={() => window.print()}>Drukuj podsumowanie</button>
          </>
        )}
      </section>
    </div>
  );
}
