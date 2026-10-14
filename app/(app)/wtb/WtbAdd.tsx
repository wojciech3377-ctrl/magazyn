"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { SearchInput } from "@/components/SearchInput";
import { withJpegPhoto } from "@/lib/image-jpeg";
import { addFromCatalog, addManual, searchWtbCatalog, type CatalogResult, type WtbAddState } from "./actions";

function thumb(url: string | null, w = 80) {
  return url ? `${url}${url.includes("?") ? "&" : "?"}width=${w}` : null;
}

/** Dodawanie do WTB: model z katalogu w kilku rozmiarach naraz albo wpis ręczny. */
export function WtbAdd() {
  const [mode, setMode] = useState<"catalog" | "manual">("catalog");
  return (
    <section className="card p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="h2 mr-2">Dodaj do WTB</h2>
        {(["catalog", "manual"] as const).map((m) => (
          <button key={m} type="button" onClick={() => setMode(m)}
            className={`rounded-md px-3 py-1 text-sm ${mode === m ? "bg-ink text-white" : "text-muted hover:bg-panel"}`}>
            {m === "catalog" ? "Z katalogu" : "Wpisz ręcznie"}
          </button>
        ))}
      </div>
      {mode === "catalog" ? <FromCatalog /> : <Manual />}
    </section>
  );
}

function FromCatalog() {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<CatalogResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<CatalogResult | null>(null);
  const [sizes, setSizes] = useState<string[]>([]);
  const [state, action, pending] = useActionState<WtbAddState, FormData>(async (prev, fd) => {
    let r: WtbAddState;
    try {
      r = await addFromCatalog(prev, await withJpegPhoto(fd));
    } catch (e) {
      return { error: e instanceof Error ? e.message : "Nie udało się dodać." };
    }
    if (r?.ok) {
      setPicked(null);
      setSizes([]);
      setQ("");
    }
    return r;
  }, null);

  useEffect(() => {
    if (picked || q.trim().length < 2) {
      setHits([]);
      return;
    }
    const t = setTimeout(async () => {
      setBusy(true);
      setHits(await searchWtbCatalog(q));
      setBusy(false);
    }, 300);
    return () => clearTimeout(t);
  }, [q, picked]);

  if (!picked) {
    return (
      <div className="space-y-2">
        <SearchInput wrapperClassName="max-w-xl" placeholder="Szukaj modelu: nazwa albo SKU, np. Jordan 4 Seafoam" value={q} onChange={(e) => setQ(e.target.value)} onScan={setQ} aria-label="Szukaj w katalogu" />
        {busy && <p className="text-xs text-muted">Szukam…</p>}
        {state?.ok && <p className="text-sm text-ok">{state.ok}</p>}
        {hits.length > 0 && (
          <ul className="max-w-xl divide-y divide-line overflow-hidden rounded-md border border-line">
            {hits.map((h) => (
              <li key={h.productId}>
                <button type="button" className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-sky-50" onClick={() => setPicked(h)}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {h.image ? <img src={thumb(h.image)!} alt="" className="h-10 w-10 rounded border border-line object-contain" /> : <span className="h-10 w-10 rounded border border-line bg-panel" />}
                  <span className="flex-1">{h.title}</span>
                  {h.sku && <span className="font-mono text-xs text-muted">{h.sku}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        {!busy && q.trim().length >= 2 && !hits.length && <p className="text-sm text-muted">Nic nie znaleziono – możesz wpisać ręcznie.</p>}
      </div>
    );
  }

  const toggle = (id: string) => setSizes((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="product_id" value={picked.productId} />
      {sizes.map((id) => <input key={id} type="hidden" name="variant_id" value={id} />)}
      <div className="flex items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {picked.image && <img src={thumb(picked.image, 120)!} alt="" className="h-14 w-14 rounded border border-line object-contain" />}
        <div>
          <div className="font-medium">{picked.title}</div>
          {picked.sku && <div className="font-mono text-xs text-muted">{picked.sku}</div>}
        </div>
        <button type="button" className="ml-auto text-sm text-muted underline" onClick={() => { setPicked(null); setSizes([]); }}>zmień model</button>
      </div>
      <div>
        <div className="label mb-1">Rozmiary (możesz zaznaczyć kilka)</div>
        <div className="flex flex-wrap gap-1.5">
          {picked.variants.map((v) => (
            <button key={v.id} type="button" onClick={() => toggle(v.id)} aria-pressed={sizes.includes(v.id)}
              className={`min-w-12 rounded-md border px-2.5 py-1 text-sm tabular-nums ${sizes.includes(v.id) ? "border-ink bg-ink text-white" : "border-line hover:bg-panel"}`}>
              {v.option}
            </button>
          ))}
        </div>
      </div>
      <input className="input max-w-xl" name="note" placeholder="Notatka (opcjonalnie, np. maks. cena) – nie trafia na grafikę" />
      <PhotoField hint="Własne zdjęcie (opcjonalnie) – zamiast zdjęcia z katalogu" />
      {state?.error && <p className="text-sm text-bad">{state.error}</p>}
      <button className="btn" disabled={pending || (!sizes.length && picked.variants.length > 0)}>
        {pending ? "Dodaję…" : sizes.length > 1 ? `Dodaj ${sizes.length} rozmiary` : "Dodaj do WTB"}
      </button>
    </form>
  );
}

function Manual() {
  const [key, setKey] = useState(0);
  const [state, action, pending] = useActionState<WtbAddState, FormData>(async (prev, fd) => {
    try {
      const r = await addManual(prev, await withJpegPhoto(fd));
      if (r?.ok) setKey((k) => k + 1);
      return r;
    } catch (e) {
      return { error: e instanceof Error ? e.message : "Nie udało się dodać." };
    }
  }, null);
  return (
    <form key={key} action={action} className="grid gap-3 md:grid-cols-[2fr_1fr_1fr]">
      <div><label className="label" htmlFor="w-title">Model</label><input id="w-title" className="input" name="title" placeholder="np. Nike SB Dunk Low Travis Scott" required /></div>
      <div><label className="label" htmlFor="w-sizes">Rozmiary</label><input id="w-sizes" className="input" name="sizes" placeholder="np. 42, 42.5, 43" /></div>
      <div><label className="label" htmlFor="w-sku">SKU</label><input id="w-sku" className="input font-mono" name="sku" placeholder="np. CT5053-001" /></div>
      <div className="md:col-span-3"><PhotoField hint="Zdjęcie (opcjonalnie) – z telefonu albo z dysku, trafia na grafikę" /></div>
      <div className="md:col-span-2"><input className="input" name="note" placeholder="Notatka (opcjonalnie) – nie trafia na grafikę" aria-label="Notatka" /></div>
      <div className="flex items-center gap-3">
        <button className="btn" disabled={pending}>{pending ? "Dodaję…" : "Dodaj do WTB"}</button>
        {state?.ok && <span className="text-sm text-ok">{state.ok}</span>}
        {state?.error && <span className="text-sm text-bad">{state.error}</span>}
      </div>
    </form>
  );
}

/** Wybór zdjęcia z podglądem (na telefonie: aparat albo galeria). Zmniejszane do JPEG przy wysyłce. */
function PhotoField({ hint }: { hint: string }) {
  const [preview, setPreview] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  // Formularz czyści pola po wysłaniu – podgląd też.
  useEffect(() => {
    const form = ref.current?.form;
    const clear = () => setPreview(null);
    form?.addEventListener("reset", clear);
    return () => form?.removeEventListener("reset", clear);
  }, []);
  return (
    <div className="flex items-center gap-3">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {preview ? <img src={preview} alt="Wybrane zdjęcie" className="h-14 w-14 rounded border border-line object-contain" /> : <span className="flex h-14 w-14 items-center justify-center rounded border border-dashed border-line text-xl text-muted">📷</span>}
      <div className="text-sm">
        <label className="btn-secondary h-8 cursor-pointer px-3 text-xs">
          {preview ? "Zmień zdjęcie" : "Dodaj zdjęcie"}
          <input ref={ref} type="file" name="photo" accept="image/*" className="sr-only"
            onChange={(e) => { const f = e.currentTarget.files?.[0]; setPreview(f ? URL.createObjectURL(f) : null); }} />
        </label>
        {preview && <button type="button" className="ml-2 text-xs text-muted underline" onClick={() => { if (ref.current) ref.current.value = ""; setPreview(null); }}>usuń</button>}
        <div className="mt-1 text-xs text-muted">{hint}</div>
      </div>
    </div>
  );
}
