"use client";

import { useActionState, useState, useTransition } from "react";
import { assignGeneralItems } from "../actions";
import { searchVariants, type VariantHit } from "@/app/(app)/dostawa/actions";

type Item = { title: string; option: string; qty: number; price: number; variant_id?: string };

/** Pozycje z ogólnego linku → produkty z katalogu → sztuki „w drodze”. */
export function AssignItems({ id, items, locations }: { id: string; items: Item[]; locations: { id: string; label: string; store_id: string }[] }) {
  const [state, action, pending] = useActionState(assignGeneralItems, null);
  // Pozycje wybrane przez klienta z katalogu są już przypisane.
  const [picked, setPicked] = useState<({ id: string; label: string } | null)[]>(items.map((i) => (i.variant_id ? { id: i.variant_id, label: `${i.title} · ${i.option}` } : null)));
  const [queries, setQueries] = useState(items.map((i) => i.title));
  const [hits, setHits] = useState<VariantHit[][]>(items.map(() => []));
  const [, start] = useTransition();

  const search = (idx: number) => start(async () => {
    const r = await searchVariants(queries[idx], locations[0]?.store_id ?? "");
    setHits((h) => h.map((x, i) => (i === idx ? r : x)));
  });

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="variants" value={JSON.stringify(picked.map((p) => p?.id ?? null))} />
      {items.map((it, idx) => (
        <div key={idx} className="rounded-md border border-line p-3">
          <div className="mb-2 text-sm">Klient wpisał: <b>{it.title}</b>, rozmiar <b>{it.option}</b>, {it.qty} szt.</div>
          {picked[idx] ? (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-ok">✓ {picked[idx]!.label}</span>
              <button type="button" className="text-muted underline" onClick={() => setPicked((p) => p.map((x, i) => (i === idx ? null : x)))}>zmień</button>
            </div>
          ) : (
            <>
              <div className="flex gap-2">
                <input className="input" value={queries[idx]} onChange={(e) => setQueries((q) => q.map((x, i) => (i === idx ? e.target.value : x)))} aria-label="Szukaj w katalogu" />
                <button type="button" className="btn-secondary" onClick={() => search(idx)}>Szukaj</button>
              </div>
              <div className="mt-2 space-y-1">
                {hits[idx].map((h) => (
                  <div key={h.productId} className="text-sm">
                    <span className="mr-2">{h.title}</span>
                    {h.variants.map((v) => (
                      <button type="button" key={v.id} className={`mr-1 mt-1 rounded border px-2 py-0.5 ${v.option === it.option ? "border-accent" : "border-line"}`}
                        onClick={() => setPicked((p) => p.map((x, i) => (i === idx ? { id: v.id, label: `${h.title} · ${v.option}` } : x)))}>
                        {v.option}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      ))}
      <div className="flex flex-wrap items-end gap-2">
        <select className="input w-64" name="location_id" aria-label="Lokalizacja">
          {locations.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
        </select>
        <button className="btn" disabled={pending || picked.some((p) => !p)}>{pending ? "Tworzę…" : "Utwórz sztuki „w drodze”"}</button>
      </div>
      {state?.error && <p className="text-sm text-bad">{state.error}</p>}
    </form>
  );
}
