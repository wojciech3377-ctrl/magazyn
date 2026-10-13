"use client";

import Link from "next/link";
import { useActionState, useEffect, useState, useTransition } from "react";
import { SearchInput } from "@/components/SearchInput";
import { SubmitButton } from "@/components/SubmitButton";
import { assignUnitsToConsignor, searchOwnUnitsForConsignor, type OwnUnitHit } from "../actions";

/** Profil komisanta: dopisanie rzeczy z magazynu (sztuki własne → komis) albo przyjęcie nowych rzeczy komisanta. */
export function AddUnits({ consignorId, prices }: { consignorId: string; prices: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<OwnUnitHit[] | null>(null);
  const [picked, setPicked] = useState<(OwnUnitHit & { payout: string })[]>([]);
  const [busy, start] = useTransition();
  const [state, action] = useActionState(assignUnitsToConsignor, null);

  useEffect(() => {
    const t = q.trim();
    if (t.length < 2) { setHits(null); return; }
    const h = setTimeout(() => start(async () => setHits(await searchOwnUnitsForConsignor(t))), 300);
    return () => clearTimeout(h);
  }, [q]);

  if (!open) {
    return (
      <div className="card mb-5 flex flex-wrap items-center gap-2 p-4">
        <span className="mr-auto font-medium">Dopisz rzeczy komisantowi</span>
        <button type="button" className="btn-secondary" onClick={() => setOpen(true)}>Z magazynu</button>
        <Link className="btn" href={`/dostawa?komisant=${consignorId}`}>Nowe rzeczy (przyjęcie)</Link>
      </div>
    );
  }
  const ids = new Set(picked.map((p) => p.id));
  return (
    <section className="card mb-5 space-y-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="h2">Dopisz rzeczy z magazynu</h2>
        <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Zamknij</button>
      </div>
      <p className="text-sm text-muted">Sztuki własne z magazynu stają się rzeczami w komisie tego komisanta. Nowe rzeczy, których jeszcze nie ma w magazynie: <Link className="text-accent hover:underline" href={`/dostawa?komisant=${consignorId}`}>Przyjęcie dostawy</Link> (komisant wybrany od razu).</p>
      <SearchInput value={q} onChange={(e) => setQ(e.target.value)} onScan={setQ} placeholder="Kod sztuki, IMEI albo nazwa" aria-label="Szukaj w magazynie" />
      {busy && <p className="text-xs text-muted">Szukam…</p>}
      {hits && (hits.length ? (
        <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded-lg border border-line">
          {hits.map((u) => (
            <li key={u.id}>
              <button type="button" disabled={ids.has(u.id)} onClick={() => setPicked((p) => [...p, { ...u, payout: "" }])}
                className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-slate-50 disabled:opacity-50">
                <span className="min-w-0 flex-1"><span className="block font-medium">{u.title} · {u.option}</span><span className="text-xs text-muted"><span className="font-mono">{u.code}</span>{u.identifier ? ` · ${u.identifier}` : ""} · {u.location}</span></span>
                <span className="text-accent">{ids.has(u.id) ? "dodane" : "+ dodaj"}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-muted">Brak własnych sztuk dla „{q}”.</p>)}
      {picked.length > 0 && (
        <form action={action} className="space-y-2">
          <input type="hidden" name="id" value={consignorId} />
          <input type="hidden" name="units" value={JSON.stringify(picked.map((p) => ({ unit_id: p.id, payout: p.payout })))} />
          <ul className="divide-y divide-line rounded-lg border border-line">
            {picked.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1">{p.title} · <b>{p.option}</b> <span className="font-mono text-xs text-muted">{p.code}</span></span>
                {prices && <input className="input w-36 text-right tabular-nums" inputMode="decimal" placeholder="kwota komisanta" value={p.payout} onChange={(e) => setPicked((l) => l.map((x) => (x.id === p.id ? { ...x, payout: e.target.value } : x)))} aria-label="Kwota dla komisanta" />}
                <button type="button" className="text-xs text-bad hover:underline" onClick={() => setPicked((l) => l.filter((x) => x.id !== p.id))}>usuń</button>
              </li>
            ))}
          </ul>
          {state?.error && <p className="text-sm text-bad">{state.error}</p>}
          <SubmitButton pendingText="Dopisuję…">Dopisz komisantowi ({picked.length})</SubmitButton>
        </form>
      )}
    </section>
  );
}
