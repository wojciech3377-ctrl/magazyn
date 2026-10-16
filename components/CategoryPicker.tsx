"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { matchesWords, searchWords } from "@/lib/search";

/**
 * Wybór kilku kategorii (kolekcji ze Shopify) naraz – rozwijana lista z wyszukiwarką i polami wyboru.
 * Lista rozwija się w miejscu (panel filtrów ucina wyskakujące okienka). Do formularza trafia jedno pole `name` z nazwami połączonymi znakiem „|”.
 */
export function CategoryPicker({ name, options, defaultValue = [], storeField }: {
  name: string;
  /** Kategorie z listą sklepów, w których są (pusta lista – pokazuj zawsze). */
  options: { title: string; stores: string[] }[];
  defaultValue?: string[];
  /** Nazwa pola wyboru sklepu w tym samym formularzu – lista pokazuje tylko kategorie wybranego sklepu. */
  storeField?: string;
}) {
  const [picked, setPicked] = useState<string[]>(defaultValue);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [store, setStore] = useState("");
  const box = useRef<HTMLDivElement>(null);
  // Sklep wybrany w formularzu (także przed wysłaniem) – zmiana sklepu odznacza kategorie innego sklepu.
  useEffect(() => {
    const form = box.current?.closest("form");
    const field = storeField ? (form?.elements.namedItem(storeField) as HTMLSelectElement | null) : null;
    if (!field) return;
    const sync = () => {
      const v = field.value;
      setStore(v);
      if (v) setPicked((p) => p.filter((t) => { const o = options.find((x) => x.title === t); return !o || !o.stores.length || o.stores.includes(v); }));
    };
    setStore(field.value);
    field.addEventListener("change", sync);
    return () => field.removeEventListener("change", sync);
  }, [storeField, options]);
  const inStore = useMemo(() => options.filter((o) => !store || !o.stores.length || o.stores.includes(store)).map((o) => o.title), [options, store]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    // „click”, nie „mousedown”: zwinięcie listy przesuwa przyciski pod nią – kliknięcie musi najpierw trafić w cel.
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open]);
  const shown = useMemo(() => {
    const words = searchWords(q);
    return words.length ? inStore.filter((o) => matchesWords(o, words)) : inStore;
  }, [q, inStore]);
  const toggle = (o: string) => setPicked((p) => (p.includes(o) ? p.filter((x) => x !== o) : [...p, o]));

  return (
    <div ref={box} className="relative">
      <input type="hidden" name={name} value={picked.join("|")} />
      <button type="button" className="input flex w-full items-center justify-between gap-2 text-left" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className={`truncate ${picked.length ? "" : "text-muted"}`}>
          {picked.length ? (picked.length <= 2 ? picked.join(", ") : `${picked.length} ${picked.length % 10 >= 2 && picked.length % 10 <= 4 && (picked.length % 100 < 12 || picked.length % 100 > 14) ? "kategorie" : "kategorii"}: ${picked.slice(0, 2).join(", ")}…`) : "Wszystkie kategorie"}
        </span>
        <span className="text-xs text-muted">▾</span>
      </button>
      {open && (
        <div className="mt-1 rounded-xl border border-line bg-white p-2">
          <input className="input mb-2 h-8" placeholder="Szukaj kategorii…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }} />
          <div className="max-h-56 overflow-y-auto">
            {shown.length ? shown.map((o) => (
              <label key={o} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-slate-50">
                <input type="checkbox" checked={picked.includes(o)} onChange={() => toggle(o)} />
                <span className="truncate">{o}</span>
              </label>
            )) : <p className="px-1.5 py-2 text-sm text-muted">Brak takiej kategorii.</p>}
          </div>
          <div className="mt-2 flex items-center justify-between border-t border-line pt-2 text-xs">
            <button type="button" className="text-muted hover:text-ink" onClick={() => setPicked([])}>Wyczyść</button>
            <span className="text-muted">wybrano {picked.length}</span>
          </div>
        </div>
      )}
    </div>
  );
}
