"use client";

import { useEffect, useState, useTransition } from "react";
import { searchVariants, type VariantHit } from "@/app/(app)/dostawa/actions";

/** Wybór produktu i rozmiaru z katalogu (pole ukryte `name`). */
export function VariantPick({ name, storeId, label }: { name: string; storeId: string; label: string }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<VariantHit[]>([]);
  const [picked, setPicked] = useState<{ id: string; text: string } | null>(null);
  const [, start] = useTransition();
  useEffect(() => {
    if (query.trim().length < 2) return setHits([]);
    const t = setTimeout(() => start(async () => setHits(await searchVariants(query, storeId))), 300);
    return () => clearTimeout(t);
  }, [query, storeId]);
  return (
    <div className="space-y-2">
      <input type="hidden" name={name} value={picked?.id ?? ""} />
      <label className="label" htmlFor={`${name}-q`}>{label}</label>
      {picked ? (
        <div className="flex items-center gap-2 text-sm">
          <b>{picked.text}</b>
          <button type="button" className="text-accent hover:underline" onClick={() => setPicked(null)}>zmień</button>
        </div>
      ) : (
        <>
          <input id={`${name}-q`} className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Nazwa, SKU modelu, EAN" />
          <div className="space-y-2">
            {hits.map((h) => (
              <div key={h.productId} className="rounded-md border border-line p-2">
                <div className="mb-1 text-sm font-medium">{h.title}</div>
                <div className="flex flex-wrap gap-1.5">
                  {h.variants.map((v) => (
                    <button type="button" key={v.id} className="rounded border border-line px-2 py-1 text-sm hover:border-accent"
                      onClick={() => setPicked({ id: v.id, text: `${h.title} ${v.option}` })}>
                      {v.option}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
