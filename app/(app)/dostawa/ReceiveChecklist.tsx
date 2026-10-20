"use client";

import { useState } from "react";
import { SubmitButton } from "@/components/SubmitButton";

export type ChecklistUnit = { id: string; title: string; option: string; code: string; extra?: string; productId?: string | null; storeId?: string | null };

/**
 * Lista rzeczy w drodze z zaznaczaniem (domyślnie wszystkie) i połączonymi przyciskami dla zaznaczonych:
 * Przyjmij na magazyn · Drukuj etykietę magazynową · Drukuj metkę sklepową.
 */
export function ReceiveChecklist({ units, action, hidden = {}, receiveLabel = "Przyjmij na magazyn", noUnitOption = false }: {
  units: ChecklistUnit[];
  action: (fd: FormData) => Promise<void>;
  hidden?: Record<string, string>;
  receiveLabel?: string;
  /** „Nie dodawaj jako przedmiot w magazynie” – sztuki w drodze znikają, umowa idzie do niewykorzystanych. */
  noUnitOption?: boolean;
}) {
  const [sel, setSel] = useState<Set<string>>(new Set(units.map((u) => u.id)));
  const [noUnit, setNoUnit] = useState(false);
  const picked = units.filter((u) => sel.has(u.id));
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
      {noUnitOption && (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="no_unit" value="1" checked={noUnit} onChange={(e) => setNoUnit(e.target.checked)} className="mt-0.5 h-4 w-4" />
          <span><b>Nie dodawaj jako przedmiot w magazynie</b> <span className="text-muted">– rzecz już jest w Magazynie (np. dodana w Shopify); zaznaczone pozycje nie tworzą nowej sztuki, a umowa trafia do niewykorzystanych – przypniesz ją na karcie sztuki.</span></span>
        </label>
      )}
      {noUnit ? (
        <SubmitButton className="btn" pendingText="Zapisuję…" disabled={!n}>Bez nowej sztuki – umowa do niewykorzystanych ({n})</SubmitButton>
      ) : (
        <PrintGroup units={picked}>
          <SubmitButton className="btn rounded-none shadow-none" pendingText="Przyjmuję…" disabled={!n}>{receiveLabel} ({n})</SubmitButton>
        </PrintGroup>
      )}
    </form>
  );
}

/**
 * Połączone przyciski dla zaznaczonych sztuk: [akcja] · etykieta magazynowa (jak „Drukuj etykietę” w Magazynie)
 * · metka sklepowa (jak „Stan produktu + metka”: jedna metka na produkt z kodem PR…, ceny ze sklepu sztuki).
 */
export function PrintGroup({ units, children, back = "/dostawa?zakladka=w-drodze" }: { units: { id: string; productId?: string | null; storeId?: string | null }[]; children?: React.ReactNode; back?: string }) {
  const ids = units.map((u) => u.id).join(",");
  const products = [...new Set(units.map((u) => u.productId).filter((x): x is string => !!x))];
  const store = units.find((u) => u.storeId)?.storeId ?? "";
  const tagSrc = `/api/metka-produkt?sklep=${store}&ids=${products.join(",")}`;
  const tagHref = `/druk/pdf?src=${encodeURIComponent(tagSrc)}&wroc=${encodeURIComponent(back)}&nazwa=metki-produktow&tytul=${encodeURIComponent(`Metki produktów (${products.length})`)}`;
  const link = (href: string, text: string, count: number) => {
    const off = !count;
    return (
      <a href={off ? undefined : href} target="_blank" rel="noreferrer" aria-disabled={off}
        className={`btn-secondary rounded-none border-0 border-t border-line shadow-none first:border-t-0 sm:border-t-0 sm:border-l sm:first:border-l-0 ${off ? "pointer-events-none opacity-50" : ""}`}>{text} ({count})</a>
    );
  };
  return (
    <div className="flex w-full flex-col overflow-hidden rounded-lg border border-line shadow-sm *:w-full sm:inline-flex sm:w-auto sm:flex-row sm:*:w-auto">
      {children}
      {link(`/etykiety?ids=${ids}`, "Drukuj etykietę magazynową", units.length)}
      {link(tagHref, "Drukuj metkę sklepową", store ? products.length : 0)}
    </div>
  );
}
