"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toJpeg } from "@/lib/image-jpeg";
import { setWtbPhoto } from "./actions";

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
export function WtbEditDialog({ formId, title, sku, sizes, used = false }: { formId: string; title: string; sku: string | null; sizes: string[]; used?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button type="button" className="text-xs text-accent hover:underline" onClick={() => ref.current?.showModal()}>Zmień nazwę / rozmiary / USED</button>
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
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="used" value="1" form={formId} defaultChecked={used} />
            <span><b>USED</b> – szukamy używanych (znacznik na karcie i na grafice)</span>
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

/** Zdjęcie karty modelu: wgranie własnego (aparat / galeria / dysk) albo powrót do zdjęcia z katalogu. */
export function WtbPhotoButton({ ids, custom, label }: { ids: string[]; custom: boolean; label: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const send = (fill: (fd: FormData) => Promise<void> | void) =>
    start(async () => {
      setError(null);
      try {
        const fd = new FormData();
        ids.forEach((id) => fd.append("ids", id));
        await fill(fd);
        const r = await setWtbPhoto(fd);
        if (r.error) setError(r.error);
        else router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Nie udało się zapisać zdjęcia.");
      }
    });
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2">
      <label className={`cursor-pointer text-xs text-accent hover:underline ${pending ? "pointer-events-none opacity-60" : ""}`}>
        {pending ? "Zapisuję zdjęcie…" : custom ? "Zmień zdjęcie" : "Dodaj zdjęcie"}
        <input type="file" accept="image/*" className="sr-only" aria-label={`Zdjęcie: ${label}`} disabled={pending}
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            if (f) send(async (fd) => { fd.set("photo", new File([await toJpeg(f)], "zdjecie.jpg", { type: "image/jpeg" })); });
          }} />
      </label>
      {custom && !pending && (
        <button type="button" className="text-xs text-muted hover:underline" onClick={() => { if (confirm("Usunąć własne zdjęcie tego modelu?")) send((fd) => { fd.set("remove", "1"); }); }}>
          usuń zdjęcie
        </button>
      )}
      {error && <span className="block w-full text-xs text-bad">{error}</span>}
    </span>
  );
}
