"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { SearchInput } from "@/components/SearchInput";

export type SortOption = { value: string; label: string };
export type FilterChip = { label: string; href: string };

/**
 * Pasek listy: wyszukiwarka z aparatem, rozwijane filtry (z licznikiem aktywnych) i sortowanie.
 * Formularz GET – adres strony zawiera filtry (działa „wstecz”, odświeżanie i linki).
 *
 * Sortowanie: wartości „pole:kierunek” (np. „przyjeta:desc”), zapisywane w parametrach `sortParam` / `dirParam`.
 */
export function ListToolbar({
  q, placeholder, hidden = {}, sort, sortParam = "sort", dirParam = "kier", active = 0, chips = [], resetHref, defaultOpen = false, children,
}: {
  q?: string;
  placeholder: string;
  hidden?: Record<string, string | undefined>;
  sort?: { value: string; options: SortOption[] };
  sortParam?: string;
  dirParam?: string | null;
  active?: number;
  chips?: FilterChip[];
  resetHref?: string;
  defaultOpen?: boolean;
  children?: React.ReactNode;
}) {
  const form = useRef<HTMLFormElement>(null);
  const [open, setOpen] = useState(defaultOpen);
  const [sortValue, setSortValue] = useState(sort?.value ?? "");
  const [field, dir] = sortValue.split(":");
  const hasFilters = !!children;

  return (
    <form ref={form} method="get" className="mb-4" onSubmit={(e) => {
      // Krótki adres: puste filtry nie trafiają do linku.
      const els = Array.from(e.currentTarget.elements) as (HTMLInputElement | HTMLSelectElement)[];
      const off = els.filter((el) => el.name && !el.disabled && el.value === "");
      off.forEach((el) => { el.disabled = true; });
      setTimeout(() => off.forEach((el) => { el.disabled = false; }), 0);
    }}>
      {Object.entries(hidden).map(([k, v]) => v ? <input key={k} type="hidden" name={k} value={v} /> : null)}
      {sort && <input type="hidden" name={sortParam} value={field ?? ""} />}
      {sort && dirParam && dir && <input type="hidden" name={dirParam} value={dir} />}

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput key={q ?? ""} name="q" defaultValue={q} placeholder={placeholder} aria-label="Szukaj" wrapperClassName="min-w-0 flex-[1_1_100%] sm:flex-[1_1_18rem]" />
        <div className="flex flex-1 gap-2 sm:flex-none">
          {hasFilters && (
            <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
              className={`btn-secondary flex-none ${open || active ? "border-accent/50 text-accent" : ""}`}>
              <Icon name="filter" className="h-4 w-4" />
              Filtry
              {active > 0 && <span className="min-w-5 rounded-full bg-accent px-1.5 text-center text-[11px] font-semibold leading-5 text-white">{active}</span>}
              <Icon name="chevron" className={`h-3.5 w-3.5 transition-transform ${open ? "-rotate-90" : "rotate-90"}`} />
            </button>
          )}
          {sort && (
            <label className="relative min-w-0 flex-1 sm:w-56 sm:flex-none">
              <span className="sr-only">Sortuj</span>
              <Icon name="sort" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <select className="input h-9 py-0 pl-9" value={sortValue} onChange={(e) => { setSortValue(e.target.value); setTimeout(() => form.current?.requestSubmit(), 0); }}>
                {sort.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          )}
          <button className="btn hidden sm:inline-flex">Szukaj</button>
        </div>
      </div>

      {hasFilters && (
        <div className={`grid transition-[grid-template-rows] duration-200 ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
          <div className="overflow-hidden">
            <div className="mt-2 rounded-xl border border-line bg-white p-3 shadow-(--shadow-card) sm:p-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">{children}</div>
              <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-line pt-3">
                {resetHref && active > 0 && <Link href={resetHref} className="btn-ghost mr-auto">Wyczyść filtry</Link>}
                <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>Zwiń</button>
                <button className="btn">Pokaż wyniki</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {chips.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {chips.map((c) => (
            <Link key={c.label} href={c.href} className="group inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent-soft py-0.5 pl-2.5 pr-1.5 text-xs font-medium text-accent hover:border-accent/60" title="Usuń filtr">
              {c.label}<Icon name="close" className="h-3.5 w-3.5 opacity-60 group-hover:opacity-100" />
            </Link>
          ))}
          {resetHref && chips.length > 1 && <Link href={resetHref} className="px-1 text-xs text-muted hover:text-ink hover:underline">wyczyść wszystko</Link>}
        </div>
      )}
    </form>
  );
}

/** Pole filtra z etykietą (w panelu filtrów). */
export function FilterField({ label, children, wide, group }: { label: string; children: React.ReactNode; wide?: boolean; group?: boolean }) {
  // `group` – pole z kilkoma kontrolkami (np. lista pól wyboru): bez otaczającego <label>, który przejmowałby kliknięcia.
  const Tag = group ? "div" : "label";
  return (
    <Tag className={`block min-w-0 ${wide ? "sm:col-span-2" : ""}`} role={group ? "group" : undefined} aria-label={group ? label : undefined}>
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      {children}
    </Tag>
  );
}
