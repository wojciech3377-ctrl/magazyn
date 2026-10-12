"use client";

import { useRef, useState } from "react";

/**
 * Kafelek modelu: kliknięcie w dowolne miejsce kafelka zaznacza (albo odznacza) wszystkie jego rozmiary.
 * Rozmiary, linki i przyciski w środku działają po swojemu.
 */
export function WtbTile({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <li
      className={`cursor-pointer select-none ${className ?? ""}`}
      onClick={(e) => {
        const t = e.target as HTMLElement;
        if (t.closest("label, input, button, a, dialog, select, textarea")) return;
        const li = e.currentTarget;
        const boxes = [...li.querySelectorAll<HTMLInputElement>('input[type="checkbox"][name="ids"]')];
        const on = !boxes.every((c) => c.checked);
        boxes.forEach((c) => (c.checked = on));
        const group = li.querySelector<HTMLInputElement>('input[data-group-check]');
        if (group) group.checked = on;
        li.closest("form")?.dispatchEvent(new Event("change", { bubbles: true }));
      }}
    >
      {children}
    </li>
  );
}

/** Zaznacza / odznacza wszystkie rozmiary jednej karty modelu. */
export function GroupCheck({ label }: { label: string }) {
  return (
    <input
      type="checkbox"
      data-group-check=""
      className="h-4 w-4"
      aria-label={`Zaznacz wszystkie rozmiary: ${label}`}
      title="Zaznacz wszystkie rozmiary"
      onChange={(e) => {
        const on = e.currentTarget.checked;
        e.currentTarget.closest("li")?.querySelectorAll<HTMLInputElement>('input[type="checkbox"][name="ids"]').forEach((c) => (c.checked = on));
      }}
    />
  );
}

/** Edycja modelu w okienku na środku ekranu (nie rozpycha i nie zasłania innych kart). */
export function WtbEditDialog({ formId, title, sku, sizes }: { formId: string; title: string; sku: string | null; sizes: string[] }) {
  const ref = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button type="button" className="text-xs text-accent hover:underline" onClick={() => ref.current?.showModal()}>Zmień nazwę / rozmiary</button>
      <dialog ref={ref} className="w-[min(92vw,28rem)] rounded-xl border border-line p-0 shadow-xl backdrop:bg-black/40" onClick={(e) => { if (e.target === ref.current) ref.current?.close(); }}>
        <div className="space-y-3 p-4">
          <div className="flex items-center justify-between">
            <h3 className="font-medium">Zmień model na liście WTB</h3>
            <button type="button" className="text-muted hover:text-ink" onClick={() => ref.current?.close()} aria-label="Zamknij">✕</button>
          </div>
          <label className="block text-sm"><span className="label">Nazwa</span>
            <input className="input" name="title" form={formId} defaultValue={title} required />
          </label>
          <label className="block text-sm"><span className="label">SKU</span>
            <input className="input" name="sku" form={formId} defaultValue={sku ?? ""} />
          </label>
          <label className="block text-sm"><span className="label">Rozmiary (oddziel przecinkiem)</span>
            <input className="input" name="sizes" form={formId} defaultValue={sizes.join(", ")} placeholder="np. 40, 41, 42,5" />
            <span className="mt-1 block text-xs text-muted">Usunięty rozmiar zniknie z listy, dopisany pojawi się na tej karcie.</span>
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => ref.current?.close()}>Anuluj</button>
            <button className="btn" form={formId}>Zapisz</button>
          </div>
        </div>
      </dialog>
    </>
  );
}

/** Lista do skopiowania: „Nazwa - SKU - rozmiar”, każdy rozmiar w osobnej linii. */
export function WtbCopyList({ lines }: { lines: string[] }) {
  const [copied, setCopied] = useState(false);
  const text = lines.join("\n");
  return (
    <section className="card p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="h2">Lista do skopiowania <span className="font-normal text-muted">({lines.length})</span></h2>
        <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={async () => { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>
          {copied ? "Skopiowano ✓" : "Kopiuj listę"}
        </button>
      </div>
      <textarea readOnly value={text} rows={Math.min(12, Math.max(3, lines.length))} className="input font-mono text-xs leading-relaxed" aria-label="Lista WTB: nazwa - SKU - rozmiar" onFocus={(e) => e.currentTarget.select()} />
    </section>
  );
}
