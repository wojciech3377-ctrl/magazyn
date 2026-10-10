"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { createLinkContract } from "./actions";
import { searchVariants, type VariantHit } from "@/app/(app)/dostawa/actions";

export type Line = { key: string; unit_id?: string; variant_id?: string; title: string; option: string; identifier?: string | null; code?: string; qty: number; price: string };

export function TemplateContractForm({
  initialLines, saleId, saleRef, locations, defaultLocation, paymentDays, mailReady,
}: {
  initialLines: Line[];
  saleId: string | null;
  saleRef: string | null;
  locations: { id: string; label: string; store_id: string }[];
  defaultLocation: string | null;
  paymentDays: number;
  mailReady: boolean;
}) {
  const [state, action, pending] = useActionState(createLinkContract, null);
  const [lines, setLines] = useState<Line[]>(initialLines);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<VariantHit[]>([]);
  const [, start] = useTransition();
  const hasNew = lines.some((l) => !l.unit_id);
  const storeId = locations.find((l) => l.id === defaultLocation)?.store_id ?? locations[0]?.store_id ?? "";

  useEffect(() => {
    if (query.trim().length < 2) return setHits([]);
    const t = setTimeout(() => start(async () => setHits(await searchVariants(query, storeId))), 300);
    return () => clearTimeout(t);
  }, [query, storeId]);

  const total = lines.reduce((s, l) => s + l.qty * (Number(l.price.replace(",", ".")) || 0), 0);

  return (
    <form action={action} className="grid gap-5 lg:grid-cols-3">
      <input type="hidden" name="lines" value={JSON.stringify(lines)} />
      {saleId && <input type="hidden" name="sale_id" value={saleId} />}
      <div className="min-w-0 space-y-5 lg:col-span-2">
        {saleRef && <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900">Umowa pod zamówienie <b>{saleRef}</b>. Po podpisie towar pojawi się jako „w drodze”, a po przyjęciu sam przypisze się do tego zamówienia.</div>}
        <section className="card overflow-x-auto">
          <table className="table">
            <thead><tr><th>Produkt</th><th>Rozmiar</th><th className="w-20">Ilość</th><th className="w-32">Cena / szt. (zł)</th><th /></tr></thead>
            <tbody>
              {lines.length === 0 && <tr><td colSpan={5} className="py-8 text-center text-muted">Dodaj produkt z wyszukiwarki poniżej.</td></tr>}
              {lines.map((l) => (
                <tr key={l.key}>
                  <td>{l.title}{l.code && <span className="block font-mono text-xs text-muted">{l.code}{l.identifier ? ` · ${l.identifier}` : ""}</span>}{!l.unit_id && <span className="block text-xs text-warn">przyjdzie po podpisie</span>}</td>
                  <td className="font-medium">{l.option}</td>
                  <td>{l.unit_id ? 1 : <input className="input" type="number" min={1} value={l.qty} onChange={(e) => setLines(lines.map((x) => (x.key === l.key ? { ...x, qty: Math.max(1, Number(e.target.value)) } : x)))} aria-label="Ilość" />}</td>
                  <td><input className="input" inputMode="decimal" value={l.price} onChange={(e) => setLines(lines.map((x) => (x.key === l.key ? { ...x, price: e.target.value } : x)))} aria-label="Cena" /></td>
                  <td><button type="button" className="text-sm text-bad hover:underline" onClick={() => setLines(lines.filter((x) => x.key !== l.key))}>Usuń</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        {(!saleId || initialLines.length === 0) && (
          <section className="card space-y-2 p-4">
            <label className="label" htmlFor="q">{saleId ? "Pozycja zamówienia nie jest powiązana z katalogiem – wybierz produkt i rozmiar" : "Dodaj produkt, który dopiero kupujesz"}</label>
            <input id="q" className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Nazwa, SKU modelu, SKU z Base, EAN" />
            <div className="space-y-2">
              {hits.map((h) => (
                <div key={h.productId} className="rounded-md border border-line p-2">
                  <div className="mb-1 text-sm font-medium">{h.title}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {h.variants.map((v) => (
                      <button type="button" key={v.id} className="rounded border border-line px-2 py-1 text-sm hover:border-accent"
                        onClick={() => setLines([...lines, { key: crypto.randomUUID(), variant_id: v.id, title: h.title, option: v.option, qty: 1, price: "" }])}>
                        {v.option}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
      <div className="min-w-0 space-y-5">
        <section className="card space-y-3 p-4">
          {hasNew && (
            <div>
              <label className="label" htmlFor="location_id">Dokąd przyjdzie towar</label>
              <select className="input" id="location_id" name="location_id" defaultValue={defaultLocation ?? locations[0]?.id ?? ""}>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>
            </div>
          )}
          <div>
            <label className="label" htmlFor="payment_days">Przelew w ciągu (dni)</label>
            <input className="input" id="payment_days" name="payment_days" type="number" min={0} max={60} defaultValue={paymentDays} />
          </div>
          <div>
            <label className="label" htmlFor="seller_email">E-mail sprzedającego (opcjonalnie)</label>
            <input className="input" id="seller_email" name="seller_email" type="email" />
          </div>
          <div>
            <label className="label" htmlFor="seller_phone">Telefon sprzedającego (opcjonalnie)</label>
            <input className="input" id="seller_phone" name="seller_phone" type="tel" />
          </div>
          <div>
            <label className="label" htmlFor="notes">Notatka wewnętrzna</label>
            <input className="input" id="notes" name="notes" />
          </div>
        </section>
        <section className="card space-y-3 p-4">
          <div className="flex items-baseline justify-between"><span className="text-sm text-muted">Razem</span><span className="text-xl font-semibold tabular-nums">{new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN" }).format(total)}</span></div>
          {state?.error && <p className="text-sm text-bad">{state.error}</p>}
          <button className="btn w-full" disabled={pending || !lines.length}>{pending ? "Tworzę…" : "Utwórz umowę i link do podpisu"}</button>
          <p className="text-xs text-muted">Sprzedający sam wpisze swoje dane i podpisze umowę na telefonie.{mailReady ? " Link możesz wysłać e-mailem z aplikacji." : ""}</p>
        </section>
      </div>
    </form>
  );
}
