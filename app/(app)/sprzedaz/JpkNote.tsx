"use client";

import { useState, useTransition } from "react";
import { saveJpkNote } from "./actions";

/** Notatka do linii JPK – zapis po wyjściu z pola (Enter też zapisuje, nie wysyła formularza eksportu). */
export function JpkNote({ lineKey, initial }: { lineKey: string; initial: string | null }) {
  const [value, setValue] = useState(initial ?? "");
  const [saved, setSaved] = useState(initial ?? "");
  const [state, setState] = useState<"idle" | "ok" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const save = () => {
    if (value.trim() === saved.trim()) return;
    start(async () => {
      const r = await saveJpkNote(lineKey, value);
      if (r.error) { setState("error"); setError(r.error); return; }
      setSaved(value.trim());
      setState("ok");
      setError(null);
      setTimeout(() => setState("idle"), 1500);
    });
  };
  return (
    <span className="block">
    <span className="flex items-center gap-1">
      <input
        className={`input h-7 min-w-36 px-2 py-0 text-xs ${state === "error" ? "border-rose-400" : ""}`}
        value={value} maxLength={500} placeholder="notatka…" aria-label="Notatka do linii JPK" title={error ?? value}
        onChange={(e) => { setValue(e.target.value); setState("idle"); }}
        onBlur={save}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } }}
      />
      <span className={`w-3 text-xs ${state === "error" ? "text-bad" : "text-ok"}`} aria-live="polite">{pending ? "…" : state === "ok" ? "✓" : state === "error" ? "!" : ""}</span>
    </span>
    {state === "error" && error && <span className="mt-0.5 block whitespace-normal text-[11px] text-bad">{error}</span>}
    </span>
  );
}
