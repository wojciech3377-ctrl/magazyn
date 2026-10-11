"use client";

import { useId, useState } from "react";

/** Wybór pliku jako wyraźny przycisk (podświetla się po najechaniu); obok nazwa wybranego pliku. */
export function FileButton({ label = "Wybierz plik", accept, onFile, disabled, hint }: {
  label?: string; accept?: string; onFile: (f: File | undefined) => void; disabled?: boolean; hint?: string;
}) {
  const id = useId();
  const [name, setName] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <label htmlFor={id} className={`inline-flex cursor-pointer items-center gap-2 rounded-md border-2 border-dashed border-accent/50 bg-sky-50 px-4 py-2.5 text-sm font-medium text-accent transition-colors hover:border-accent hover:bg-accent hover:text-white focus-within:ring-2 focus-within:ring-accent ${disabled ? "pointer-events-none opacity-50" : ""}`}>
        <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 fill-current"><path d="M10 2l4 4h-3v6H9V6H6l4-4zM4 14h12v2H4z" /></svg>
        {name ? "Zmień plik" : label}
        <input id={id} type="file" accept={accept} className="sr-only" disabled={disabled}
          onChange={(e) => { const f = e.target.files?.[0]; setName(f?.name ?? null); onFile(f); }} />
      </label>
      <span className="text-sm text-muted">{name ?? hint ?? "PDF, JPG albo PNG"}</span>
    </div>
  );
}
