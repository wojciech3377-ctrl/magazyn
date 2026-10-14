"use client";

import { useEffect, useRef, useState } from "react";

const pad = (n: number) => String(n).padStart(2, "0");
/** „2026-10-14” → „14.10.2026”. */
export function plDate(iso: string | null | undefined) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  return m ? `${m[3]}.${m[2]}.${m[1]}` : "";
}
/** Wpisana data → „rrrr-mm-dd” albo null: 14.10.2026, 14/10/26, 14-10-2026, 14102026, 2026-10-14. */
export function parsePlDate(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  let d: number, m: number, y: number;
  let x = /^(\d{4})[-./ ](\d{1,2})[-./ ](\d{1,2})$/.exec(t);
  if (x) [y, m, d] = [Number(x[1]), Number(x[2]), Number(x[3])];
  else if ((x = /^(\d{1,2})[-./ ](\d{1,2})[-./ ](\d{2}|\d{4})$/.exec(t))) [d, m, y] = [Number(x[1]), Number(x[2]), Number(x[3])];
  else if ((x = /^(\d{2})(\d{2})(\d{4}|\d{2})$/.exec(t))) [d, m, y] = [Number(x[1]), Number(x[2]), Number(x[3])];
  else return null;
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d || y < 1900 || y > 2100) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * Pole daty: pierwsze kliknięcie otwiera kalendarz, drugie – wpisywanie z klawiatury (dd.mm.rrrr).
 * Do formularza trafia „rrrr-mm-dd” (ukryte pole o podanej nazwie), tak jak z <input type="date">.
 */
export function DateField({ name, id, defaultValue, value, onChange, required, className = "", min, max, ...aria }: {
  name: string; id?: string; defaultValue?: string | null; value?: string; onChange?: (iso: string) => void;
  required?: boolean; className?: string; min?: string; max?: string; "aria-label"?: string;
}) {
  const controlled = value !== undefined;
  const [iso, setIso] = useState(value ?? defaultValue ?? "");
  const [text, setText] = useState(plDate(value ?? defaultValue));
  const [typing, setTyping] = useState(false);
  const [bad, setBad] = useState(false);
  const textRef = useRef<HTMLInputElement>(null);
  const pickRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (controlled && value !== iso) { setIso(value ?? ""); setText(plDate(value)); setBad(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const commit = (next: string) => {
    setIso(next);
    setText(plDate(next));
    setBad(false);
    onChange?.(next);
  };
  const openPicker = () => {
    const p = pickRef.current;
    if (!p) return;
    try { p.showPicker(); } catch { p.focus(); p.click(); }
  };

  return (
    <span className={`relative block ${className}`}>
      <input type="hidden" name={name} value={iso} />
      <input
        ref={textRef}
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder="dd.mm.rrrr"
        required={required}
        aria-label={aria["aria-label"]}
        aria-invalid={bad || undefined}
        title="Kliknij – kalendarz. Kliknij jeszcze raz – wpisz datę (dd.mm.rrrr)."
        className={`input pr-10 tabular-nums ${bad ? "border-bad" : ""}`}
        readOnly={!typing}
        value={text}
        onMouseDown={(e) => {
          if (typing) return;
          // Pierwsze kliknięcie: kalendarz. Następne: wpisywanie.
          e.preventDefault();
          openPicker();
          setTyping(true);
        }}
        onFocus={(e) => { if (typing) e.currentTarget.select(); }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (!typing && /^[0-9]$/.test(e.key)) { setTyping(true); setText(""); }
          if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
        }}
        onBlur={() => {
          setTyping(false);
          if (!text.trim()) { commit(""); return; }
          const parsed = parsePlDate(text);
          if (parsed) commit(parsed);
          else setBad(true);
        }}
      />
      <button type="button" tabIndex={-1} onClick={openPicker} aria-label="Otwórz kalendarz"
        className="absolute right-1 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-ink">
        <svg viewBox="0 0 24 24" className="h-4.5 w-4.5" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3.5" y="5" width="17" height="15" rx="2" /><path d="M3.5 9.5h17M8 3v4M16 3v4" /></svg>
      </button>
      {/* Kalendarz przeglądarki – niewidoczne pole pod polem tekstowym, żeby kalendarz otwierał się w tym miejscu. */}
      <input ref={pickRef} type="date" tabIndex={-1} aria-hidden="true" min={min} max={max} value={iso}
        className="pointer-events-none absolute bottom-0 left-0 h-px w-full opacity-0"
        onChange={(e) => { commit(e.target.value); setTyping(true); }} />
      {bad && <span className="mt-1 block text-xs text-bad">Wpisz datę jako dd.mm.rrrr, np. 14.10.2026.</span>}
    </span>
  );
}
