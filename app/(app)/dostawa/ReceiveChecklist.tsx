"use client";

import { useState } from "react";
import { SubmitButton } from "@/components/SubmitButton";

export type ChecklistUnit = { id: string; title: string; option: string; code: string; extra?: string };

/**
 * Lista rzeczy w drodze z zaznaczaniem (domyślnie wszystkie) i połączonymi przyciskami dla zaznaczonych:
 * Przyjmij na magazyn · Drukuj etykietę magazynową · Drukuj metkę sklepową.
 */
export function ReceiveChecklist({ units, action, hidden = {}, receiveLabel = "Przyjmij na magazyn" }: {
  units: ChecklistUnit[];
  action: (fd: FormData) => Promise<void>;
  hidden?: Record<string, string>;
  receiveLabel?: string;
}) {
  const [sel, setSel] = useState<Set<string>>(new Set(units.map((u) => u.id)));
  const picked = units.filter((u) => sel.has(u.id));
  const ids = picked.map((u) => u.id).join(",");
  const n = picked.length;
  const toggle = (id: string) => setSel((s) => { const x = new Set(s); if (x.has(id)) x.delete(id); else x.add(id); return x; });
  return (
    <form action={action} className="space-y-3">
      {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {units.length > 1 && (
        <label className="flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" className="h-4 w-4" checked={n === units.length} onChange={() => setSel(n === units.length ? new Set() : new Set(units.map((u) => u.id)))} />
          zaznacz wszystkie ({n}/{units.length})
        </label>
      )}
      <ul className="grid gap-1 text-sm sm:grid-cols-2">
        {units.map((u) => (
          <li key={u.id}>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="unit" value={u.id} checked={sel.has(u.id)} onChange={() => toggle(u.id)} className="h-4 w-4" />
              <span>{u.title} · <b>{u.option}</b> <span className="font-mono text-xs text-muted">{u.code}</span>{u.extra && <span className="text-xs text-muted"> · {u.extra}</span>}</span>
            </label>
          </li>
        ))}
      </ul>
      <PrintGroup ids={ids} count={n}>
        <SubmitButton className="btn rounded-none shadow-none" pendingText="Przyjmuję…" disabled={!n}>{receiveLabel} ({n})</SubmitButton>
      </PrintGroup>
    </form>
  );
}

/** Połączone przyciski: [akcja] · etykieta magazynowa · metka sklepowa – dla zaznaczonych sztuk. */
export function PrintGroup({ ids, count, children }: { ids: string; count: number; children?: React.ReactNode }) {
  const off = !count;
  const link = (href: string, text: string) => (
    <a href={off ? undefined : href} target="_blank" rel="noreferrer" aria-disabled={off}
      className={`btn-secondary rounded-none border-0 border-t border-line shadow-none first:border-t-0 sm:border-t-0 sm:border-l sm:first:border-l-0 ${off ? "pointer-events-none opacity-50" : ""}`}>{text} ({count})</a>
  );
  return (
    <div className="flex w-full flex-col overflow-hidden rounded-lg border border-line shadow-sm *:w-full sm:inline-flex sm:w-auto sm:flex-row sm:*:w-auto">
      {children}
      {link(`/etykiety?ids=${ids}`, "Drukuj etykietę magazynową")}
      {link(`/metka?ids=${ids}`, "Drukuj metkę sklepową")}
    </div>
  );
}
