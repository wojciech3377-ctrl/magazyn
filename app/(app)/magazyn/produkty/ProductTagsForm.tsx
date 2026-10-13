"use client";

import Link from "next/link";
import { useState } from "react";

export type ProductRow = { id: string; title: string; sku: string | null; image: string | null; code: string | null; inStore: number; total: number; linked: boolean };

/** Lista produktów z zaznaczaniem i wydrukiem metek (PDF w podglądzie z Drukuj / Udostępnij). */
export function ProductTagsForm({ rows, storeId, storeName, thumbs }: { rows: ProductRow[]; storeId: string; storeName: string; thumbs: Record<string, React.ReactNode> }) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const all = rows.length > 0 && sel.size === rows.length;
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const print = () => {
    const ids = rows.filter((r) => sel.has(r.id)).map((r) => r.id).slice(0, 200);
    if (!ids.length) return;
    const src = `/api/metka-produkt?sklep=${storeId}&ids=${ids.join(",")}`;
    window.location.href = `/druk/pdf?src=${encodeURIComponent(src)}&wroc=${encodeURIComponent(window.location.pathname + window.location.search)}&nazwa=metki-produktow&tytul=${encodeURIComponent(`Metki produktów (${ids.length})`)}`;
  };
  return (
    <div className="card">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-line bg-white/95 px-4 py-3 backdrop-blur">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" className="h-5 w-5" checked={all} onChange={() => setSel(all ? new Set() : new Set(rows.map((r) => r.id)))} />
          Zaznacz wszystkie ({rows.length})
        </label>
        <span className="text-sm text-muted">{sel.size ? `zaznaczono ${sel.size}` : "nic nie zaznaczono"} · ceny ze sklepu {storeName}</span>
        <button type="button" className="btn ml-auto" disabled={!sel.size} onClick={print}>Drukuj metki{sel.size ? ` (${Math.min(sel.size, 200)})` : ""}</button>
      </div>
      <ul className="divide-y divide-line">
        {rows.map((r) => (
          <li key={r.id} className={`flex items-center gap-3 px-4 py-2.5 ${sel.has(r.id) ? "bg-accent-soft/40" : ""}`}>
            <input type="checkbox" className="h-5 w-5 shrink-0" checked={sel.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Zaznacz ${r.title}`} />
            {thumbs[r.id]}
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => toggle(r.id)}>
              <span className="block font-medium leading-snug">{r.title}</span>
              <span className="text-xs text-muted">{r.sku ?? "bez SKU"}{r.code ? <> · <span className="font-mono">{r.code}</span></> : null}{!r.linked ? " · brak w tym sklepie (bez ceny)" : ""}</span>
            </button>
            <span className="shrink-0 text-right text-sm tabular-nums">
              <b>{r.inStore}</b> szt.<span className="block text-xs text-muted">razem {r.total}</span>
            </span>
            {r.code && <Link className="btn-secondary shrink-0" href={`/magazyn/produkt/${r.code}`}>Rozmiary</Link>}
          </li>
        ))}
      </ul>
    </div>
  );
}
