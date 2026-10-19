"use client";

/**
 * Rozmiar do kliknięcia (dostawa, umowy): wybrany – podświetlony, z liczbą zaznaczonych sztuk w rogu,
 * obok „−” do odjęcia jednej. Widać od razu, bez przewijania do listy na dole.
 */
export function SizeChip({ label, sub, count, onAdd, onRemove, small = false, title }: {
  label: string; sub?: string; count: number; onAdd: () => void; onRemove?: () => void; small?: boolean; title?: string;
}) {
  const on = count > 0;
  return (
    <span className="relative inline-flex items-stretch">
      <button type="button" onClick={onAdd} title={title} aria-pressed={on}
        className={`relative rounded-md border text-sm transition-colors ${small ? "px-2 py-0.5" : "px-2.5 py-1.5"} ${on ? "border-accent bg-accent text-white hover:bg-accent-dark" : "border-line hover:border-accent hover:bg-accent/5"} ${on && onRemove ? "rounded-r-none" : ""}`}>
        <b>{label}</b>
        {sub && <span className={`ml-1.5 text-xs ${on ? "text-white/80" : "text-muted"}`}>{sub}</span>}
        {on && (
          <span className="pointer-events-none absolute -left-2 -top-2 min-w-5 rounded-full bg-orange-500 px-1.5 text-center text-[11px] font-bold leading-5 text-white shadow" aria-label={`zaznaczone: ${count}`}>{count}</span>
        )}
      </button>
      {on && onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Odejmij jedną sztukę ${label}`} title="Odejmij jedną"
          className={`rounded-r-md border border-l-0 border-accent bg-white px-1.5 text-sm font-bold text-accent hover:bg-accent/10 ${small ? "py-0.5" : "py-1.5"}`}>−</button>
      )}
    </span>
  );
}
