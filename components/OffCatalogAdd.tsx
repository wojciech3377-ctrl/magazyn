"use client";

import { useState, useTransition } from "react";
import { createOffCatalogVariant } from "@/app/(app)/dostawa/actions";

/**
 * „Nie ma w katalogu Shopify” – nazwa i rozmiar(y) wpisane ręcznie. Każdy rozmiar dostaje produkt
 * „nieprzypisany do Shopify” (przypiszesz go później na karcie sztuki).
 */
export function OffCatalogAdd({ onAdd, hint }: { onAdd: (v: { variantId: string; title: string; option: string }) => void; hint?: string }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [sizes, setSizes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!open) return <button type="button" className="text-sm text-accent hover:underline" onClick={() => setOpen(true)}>Nie ma w katalogu Shopify? Dodaj ręcznie</button>;
  const add = () => start(async () => {
    setError(null);
    const list = sizes.split(/[;,]|\s{2,}/).map((s) => s.trim()).filter(Boolean);
    for (const option of list.length ? list : [""]) {
      const r = await createOffCatalogVariant(title, option);
      if (r.error || !r.variantId) { setError(r.error ?? "Nie udało się dodać."); return; }
      onAdd({ variantId: r.variantId, title: title.trim(), option: option || "jeden rozmiar" });
    }
    setTitle(""); setSizes(""); setOpen(false);
  });
  return (
    <div className="space-y-2 rounded-lg border border-dashed border-line p-3">
      <div className="text-xs text-muted">{hint ?? "Rzecz spoza katalogu – dostanie znacznik „nieprzypisany do Shopify”, przypiszesz ją później na karcie sztuki."}</div>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_10rem_auto]">
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="nazwa, np. Nike Air Max 1 Patta" aria-label="Nazwa rzeczy"
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
        <input className="input" value={sizes} onChange={(e) => setSizes(e.target.value)} placeholder="rozmiar(y): 42, 43" aria-label="Rozmiary"
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
        <div className="flex gap-2">
          <button type="button" className="btn-secondary" disabled={pending || title.trim().length < 2} onClick={add}>{pending ? "Dodaję…" : "Dodaj"}</button>
          <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Anuluj</button>
        </div>
      </div>
      {error && <p className="text-sm text-bad">{error}</p>}
    </div>
  );
}
