"use client";

import { useEffect, useState, useTransition } from "react";
import { SearchInput } from "@/components/SearchInput";
import { Icon } from "@/components/icons";
import { searchVariants, type VariantHit } from "@/app/(app)/dostawa/actions";
import { searchUnitsWithoutContract, type NoContractUnit } from "./actions";

type Picked =
  | { kind: "unit"; key: string; code: string; label: string }
  | { kind: "variant"; key: string; variantId: string; label: string };

const STATUS: Record<string, string> = { in_stock: "na stanie", reserved: "rezerwacja", in_transit: "w drodze" };

/** Miniatura zdjęcia produktu (Shopify CDN w małym rozmiarze). */
function Photo({ src }: { src: string | null }) {
  // eslint-disable-next-line @next/next/no-img-element
  return src ? <img src={`${src}${src.includes("?") ? "&" : "?"}width=120`} alt="" loading="lazy" className="h-12 w-12 shrink-0 rounded-md border border-line bg-white object-contain" />
    : <span className="h-12 w-12 shrink-0 rounded-md border border-line bg-slate-50" />;
}
const UsedTag = () => <span className="ml-1.5 inline-block rounded bg-amber-100 px-1.5 py-px align-middle text-[10px] font-semibold uppercase tracking-wide text-amber-800">używany</span>;

/**
 * Rzeczy na umowie: (1) z katalogu sklepu – model i rozmiar, gdy sztuki jeszcze nie ma w magazynie,
 * (2) rzeczy w sklepie bez umowy – konkretne sztuki (kod / IMEI). Pola ukryte: `units` (kody) i `catalog_items`.
 */
export function ContractItemsPicker({ defaultCodes }: { defaultCodes: string[] }) {
  const [picked, setPicked] = useState<Picked[]>(defaultCodes.map((c) => ({ kind: "unit", key: `u:${c}`, code: c, label: c })));
  const [unitQ, setUnitQ] = useState("");
  const [units, setUnits] = useState<NoContractUnit[] | null>(null);
  const [catQ, setCatQ] = useState("");
  const [cat, setCat] = useState<VariantHit[]>([]);
  const [busy, start] = useTransition();
  const [busyCat, startCat] = useTransition();

  useEffect(() => {
    const q = unitQ.trim();
    if (!q) { setUnits(null); return; }
    const t = setTimeout(() => start(async () => setUnits(await searchUnitsWithoutContract(q))), 300);
    return () => clearTimeout(t);
  }, [unitQ]);
  useEffect(() => {
    if (catQ.trim().length < 2) { setCat([]); return; }
    const t = setTimeout(() => startCat(async () => setCat(await searchVariants(catQ, ""))), 300);
    return () => clearTimeout(t);
  }, [catQ]);

  const add = (p: Picked) => setPicked((list) => (list.some((x) => x.key === p.key) && p.kind === "unit" ? list : [...list, p]));
  const remove = (key: string, i: number) => setPicked((list) => list.filter((x, j) => !(x.key === key && j === i)));
  const codes = picked.filter((p): p is Extract<Picked, { kind: "unit" }> => p.kind === "unit").map((p) => p.code);
  const variants = picked.filter((p): p is Extract<Picked, { kind: "variant" }> => p.kind === "variant").map((p) => ({ variant_id: p.variantId }));

  return (
    <div className="space-y-3 md:col-span-2">
      <input type="hidden" name="units" value={codes.join(" ")} />
      <input type="hidden" name="catalog_items" value={JSON.stringify(variants)} />
      <div className="label mb-0">Rzeczy na umowie</div>

      {picked.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {picked.map((p, i) => (
            <li key={`${p.key}-${i}`} className={`inline-flex items-center gap-1.5 rounded-full border py-1 pl-2.5 pr-1 text-sm ${p.kind === "unit" ? "border-emerald-200 bg-emerald-50" : "border-accent/30 bg-accent-soft"}`}>
              <span className="text-[11px] font-semibold uppercase text-muted">{p.kind === "unit" ? "sztuka" : "katalog"}</span>
              <span className="max-w-64 truncate">{p.label}</span>
              <button type="button" onClick={() => remove(p.key, i)} className="rounded-full p-0.5 text-muted hover:bg-white hover:text-bad" aria-label={`Usuń ${p.label}`}><Icon name="close" className="h-3.5 w-3.5" /></button>
            </li>
          ))}
        </ul>
      )}

      <div className="rounded-xl border border-line p-3">
        <div className="mb-1.5 text-xs font-medium text-muted">1. Z katalogu sklepu – model i rozmiar (rzeczy jeszcze nie ma w magazynie)</div>
        <SearchInput value={catQ} onChange={(e) => setCatQ(e.target.value)} onScan={setCatQ} placeholder="Nazwa, SKU modelu albo EAN" aria-label="Szukaj w katalogu" />
        {busyCat && <p className="mt-1 text-xs text-muted">Szukam…</p>}
        {cat.length > 0 && (
          <div className="mt-2 max-h-72 space-y-2 overflow-y-auto">
            {cat.map((h) => (
              <div key={h.productId} className="rounded-lg border border-line p-2">
                <div className="mb-1.5 flex items-center gap-2.5">
                  <Photo src={h.image} />
                  <div className="min-w-0 text-sm font-medium">
                    <span className="line-clamp-2">{h.title}{h.used && <UsedTag />}</span>
                    {h.styleSku && <span className="block truncate text-xs font-normal text-muted">{h.styleSku}</span>}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1">
                  {h.variants.map((v) => (
                    <button type="button" key={v.id} onClick={() => add({ kind: "variant", key: `v:${v.id}:${Date.now()}`, variantId: v.id, label: `${h.title} ${v.option}` })}
                      className="rounded-md border border-line px-2 py-0.5 text-sm hover:border-accent hover:text-accent">{v.option}</button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-xl border border-line p-3">
        <div className="mb-1.5 text-xs font-medium text-muted">2. Rzeczy w sklepie bez umowy (kod sztuki, IMEI, nazwa)</div>
        <SearchInput value={unitQ} onChange={(e) => setUnitQ(e.target.value)} placeholder="np. S000123, IMEI albo Air Force 1 42" aria-label="Szukaj rzeczy bez umowy"
          onScan={(code) => setUnitQ(code)} onFocus={() => { if (!unitQ) start(async () => setUnits(await searchUnitsWithoutContract(""))); }} />
        {busy && <p className="mt-1 text-xs text-muted">Szukam…</p>}
        {units && (
          units.length ? (
            <ul className="mt-2 max-h-72 divide-y divide-line overflow-y-auto rounded-lg border border-line">
              {units.map((u) => {
                const on = codes.includes(u.code);
                return (
                  <li key={u.id}>
                    <button type="button" disabled={on} onClick={() => add({ kind: "unit", key: `u:${u.code}`, code: u.code, label: `${u.code} · ${u.title} ${u.option}` })}
                      className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-slate-50 disabled:opacity-50">
                      <Photo src={u.image} />
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium leading-snug">{u.title} · {u.option}{u.used && <UsedTag />}</span>
                        <span className="text-xs text-muted"><span className="font-mono">{u.code}</span>{u.identifier ? ` · ${u.identifier}` : ""} · {STATUS[u.status] ?? u.status}{u.store ? ` · ${u.store}` : ""}</span>
                      </span>
                      {on ? <Icon name="check" className="h-4 w-4 text-ok" /> : <Icon name="plus" className="h-4 w-4 text-accent" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : <p className="mt-2 text-sm text-muted">Brak rzeczy bez umowy dla „{unitQ}”.</p>
        )}
      </div>
    </div>
  );
}
