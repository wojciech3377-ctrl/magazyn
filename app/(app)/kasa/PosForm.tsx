"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { finishPosOrder, pickUnitForVariant, scanUnit, searchUnits, type PosUnit, type ScanChoice } from "./actions";

type Line = PosUnit & { priceInput: string };
const PAYMENTS = [["card", "Karta"], ["cash", "Gotówka"], ["blik", "BLIK"], ["transfer", "Przelew"]] as const;
const fmt = (n: number) => new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN" }).format(n);

export function PosForm({ stores }: { stores: { id: string; name: string }[] }) {
  const [state, action, submitting] = useActionState(finishPosOrder, null);
  const [storeId, setStoreId] = useState(stores[0]?.id ?? "");
  const [lines, setLines] = useState<Line[]>([]);
  const [scan, setScan] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<PosUnit[]>([]);
  const [payment, setPayment] = useState("card");
  const [choices, setChoices] = useState<ScanChoice[] | null>(null);
  const [busy, start] = useTransition();
  const scanRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (query.trim().length < 2) return setHits([]);
    const t = setTimeout(() => start(async () => setHits(await searchUnits(query, storeId))), 300);
    return () => clearTimeout(t);
  }, [query, storeId]);

  function add(u: PosUnit) {
    if (lines.some((l) => l.id === u.id)) {
      setMessage({ tone: "error", text: `${u.code} jest już w koszyku.` });
      return;
    }
    setLines((prev) => [...prev, { ...u, priceInput: u.price !== null ? String(u.price) : "" }]);
    setMessage({ tone: "ok", text: `Dodano ${u.code} · ${u.title} ${u.option}` });
  }

  function onScan(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const code = scan;
    setScan("");
    if (!code.trim()) return;
    start(async () => {
      const r = await scanUnit(code, storeId, lines.map((l) => l.id));
      setChoices(null);
      if (r.unit) add(r.unit);
      else if (r.choices) {
        setChoices(r.choices);
        setMessage({ tone: "ok", text: "To SKU modelu – wybierz rozmiar." });
      } else setMessage({ tone: "error", text: r.error ?? "Nie znaleziono." });
      scanRef.current?.focus();
    });
  }

  function pick(ch: ScanChoice) {
    start(async () => {
      const r = await pickUnitForVariant(ch.variantId, storeId, lines.map((l) => l.id));
      if (r.unit) {
        add(r.unit);
        setChoices(null);
      } else setMessage({ tone: "error", text: r.error ?? "Brak sztuki." });
      scanRef.current?.focus();
    });
  }

  const total = lines.reduce((s, l) => s + (Number(l.priceInput.replace(",", ".")) || 0), 0);

  return (
    <form action={action} className="grid gap-5 lg:grid-cols-3">
      <input type="hidden" name="items" value={JSON.stringify(lines.map((l) => ({ unit_id: l.id, price: l.priceInput })))} />
      <input type="hidden" name="payment" value={payment} />

      <div className="min-w-0 space-y-5 lg:col-span-2">
        <section className="card space-y-3 p-4">
          <label className="label" htmlFor="scan">Skanuj albo wpisz kod</label>
          <input
            ref={scanRef}
            id="scan"
            className="input py-3 font-mono text-lg"
            value={scan}
            onChange={(e) => setScan(e.target.value)}
            onKeyDown={onScan}
            placeholder="Etykieta S000123, IMEI, SKU z Base, SKU ze Shopify lub EAN – potem Enter"
            autoFocus
            autoComplete="off"
          />
          {message && <p className={`text-sm ${message.tone === "ok" ? "text-ok" : "text-bad"}`}>{message.text}</p>}
          {choices && (
            <div className="rounded-md border border-line p-3">
              <div className="mb-2 text-sm font-medium">{choices[0]?.title}</div>
              <div className="flex flex-wrap gap-1.5">
                {choices.map((ch) => (
                  <button type="button" key={ch.variantId} disabled={ch.inStock === 0} onClick={() => pick(ch)}
                    className="rounded-md border border-line px-2.5 py-1.5 text-sm hover:border-accent disabled:opacity-40">
                    <b>{ch.option}</b> <span className="text-xs text-muted">{ch.inStock} szt.</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <details className="text-sm" open={query.length > 0}>
            <summary className="cursor-pointer text-muted">Dodaj ręcznie – wyszukaj produkt</summary>
            <input className="input mt-2" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Nazwa, SKU modelu, SKU z Base, EAN" aria-label="Szukaj produktu" />
            {busy && query && <p className="mt-2 text-muted">Szukam…</p>}
            <ul className="mt-2 divide-y divide-line">
              {hits.map((u) => (
                <li key={u.id} className="flex items-center gap-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{u.title} · {u.option}</span>
                    <span className="text-xs text-muted">{u.code}{u.identifier ? ` · ${u.identifier}` : ""} · {u.location}{u.owner ? ` · komis ${u.owner}` : ""}</span>
                  </span>
                  <span className="tabular-nums">{u.price !== null ? fmt(u.price) : "–"}</span>
                  <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={() => add(u)} disabled={lines.some((l) => l.id === u.id)}>Dodaj</button>
                </li>
              ))}
              {query.trim().length >= 2 && !busy && hits.length === 0 && <li className="py-2 text-muted">Brak sztuk na stanie dla tego wyszukiwania.</li>}
            </ul>
          </details>
        </section>

        <section className="card overflow-x-auto">
          <table className="table">
            <thead><tr><th>Sztuka</th><th>Produkt</th><th className="w-36">Cena (zł)</th><th /></tr></thead>
            <tbody>
              {lines.length === 0 && <tr><td colSpan={4} className="py-8 text-center text-muted">Zeskanuj pierwszą sztukę.</td></tr>}
              {lines.map((l) => (
                <tr key={l.id}>
                  <td className="whitespace-nowrap font-mono text-xs">{l.code}{l.identifier && <span className="block text-muted">{l.identifier}</span>}</td>
                  <td>{l.title} · <b>{l.option}</b>{l.owner && <span className="block text-xs text-muted">komis · {l.owner}</span>}</td>
                  <td>
                    <input className="input tabular-nums" inputMode="decimal" value={l.priceInput} aria-label={`Cena ${l.code}`}
                      onChange={(e) => setLines((p) => p.map((x) => (x.id === l.id ? { ...x, priceInput: e.target.value } : x)))} />
                  </td>
                  <td><button type="button" className="text-sm text-bad hover:underline" onClick={() => setLines((p) => p.filter((x) => x.id !== l.id))}>Usuń</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <div className="min-w-0 space-y-5">
        <section className="card space-y-3 p-4">
          <div>
            <label className="label" htmlFor="store_id">Sklep</label>
            <select className="input" id="store_id" name="store_id" value={storeId} onChange={(e) => setStoreId(e.target.value)}>
              {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div>
            <div className="label">Płatność</div>
            <div className="grid grid-cols-2 gap-1.5">
              {PAYMENTS.map(([k, label]) => (
                <button type="button" key={k} onClick={() => setPayment(k)}
                  className={`rounded-md border px-2 py-2 text-sm ${payment === k ? "border-accent bg-accent/5 font-medium" : "border-line"}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="label" htmlFor="customer">Klient (opcjonalnie)</label>
            <input className="input" id="customer" name="customer" />
          </div>
          <div>
            <label className="label" htmlFor="note">Notatka</label>
            <input className="input" id="note" name="note" />
          </div>
        </section>
        <section className="card space-y-3 p-4">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-muted">{lines.length} szt.</span>
            <span className="text-2xl font-semibold tabular-nums">{fmt(total)}</span>
          </div>
          {state?.error && <p className="text-sm text-bad">{state.error}</p>}
          <button className="btn w-full py-3 text-base" disabled={submitting || !lines.length}>{submitting ? "Zapisuję…" : "Zakończ sprzedaż"}</button>
          <p className="text-xs text-muted">Sztuki zmienią status na „sprzedana”, a stan w Base spadnie o 1 za każdą (Base zaktualizuje sklepy). Paragon wystawiasz na kasie fiskalnej jak dotąd.</p>
        </section>
      </div>
    </form>
  );
}
