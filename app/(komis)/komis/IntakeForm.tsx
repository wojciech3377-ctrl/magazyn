"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { createIntake, searchCatalog, type CatalogHit, type IntakeState } from "./intake-actions";

type Loc = { id: string; label: string; address: string | null };
type Row = { key: string; variant_id: string | null; title: string; option: string; price: string; purchase_form: "" | "vat_margin" | "vat_23" };

/** Zgłoszenie rzeczy do wysłania do nas: adres (nasza lokalizacja), rzeczy z katalogu albo opisane, kwota komisanta. */
export function IntakeForm({ locations }: { locations: Loc[] }) {
  const [state, action, pending] = useActionState<IntakeState, FormData>(createIntake, null);
  const [loc, setLoc] = useState(locations[0]?.id ?? "");
  const [rows, setRows] = useState<Row[]>([]);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<CatalogHit[]>([]);
  const [, start] = useTransition();
  const [defaultForm, setDefaultForm] = useState<Row["purchase_form"]>("");

  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return; }
    const t = setTimeout(() => start(async () => setHits(await searchCatalog(q))), 300);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => { if (state?.ok) setRows([]); }, [state]);

  const add = (r: Omit<Row, "key">) => setRows((x) => [...x, { ...r, key: crypto.randomUUID() }]);
  const set = (key: string, patch: Partial<Row>) => setRows((x) => x.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const address = locations.find((l) => l.id === loc);

  return (
    <form action={action} className="card space-y-4 p-4">
      <div>
        <label className="label" htmlFor="intake-loc">Wyślij na adres:</label>
        <select id="intake-loc" className="input max-w-md" name="location_id" value={loc} onChange={(e) => setLoc(e.target.value)}>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
        </select>
        {address?.address && <p className="mt-1 whitespace-pre-line text-sm text-muted">{address.address}</p>}
      </div>

      <div className="space-y-2">
        <label className="label" htmlFor="intake-q">Dodaj rzecz z naszego katalogu</label>
        <input id="intake-q" className="input max-w-md" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nazwa modelu, SKU albo EAN" />
        {hits.length > 0 && (
          <div className="max-h-64 max-w-xl overflow-y-auto rounded-md border border-line">
            {hits.map((h) => (
              <button key={h.variantId} type="button" className="flex w-full items-center gap-2 border-b border-line px-2 py-1.5 text-left text-sm last:border-0 hover:bg-panel"
                onClick={() => { add({ variant_id: h.variantId, title: h.title, option: h.option, price: "", purchase_form: defaultForm }); setQ(""); setHits([]); }}>
                {h.image ? <img src={`${h.image}${h.image.includes("?") ? "&" : "?"}width=60`} alt="" className="h-8 w-8 rounded object-contain" /> : <span className="h-8 w-8 rounded bg-panel" />}
                <span className="flex-1">{h.title}</span><b>{h.option}</b>
              </button>
            ))}
          </div>
        )}
        <button type="button" className="text-sm text-accent hover:underline" onClick={() => add({ variant_id: null, title: "", option: "", price: "", purchase_form: defaultForm })}>Nie ma w katalogu – opiszę sam</button>
      </div>

      {rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">Rozliczenie dla wszystkich:</span>
          {(["vat_margin", "vat_23"] as const).map((f) => (
            <button key={f} type="button" className={`rounded-md border px-3 py-1.5 transition-colors ${defaultForm === f ? "border-accent bg-accent text-white" : "border-line bg-white hover:border-accent hover:bg-sky-50"}`}
              onClick={() => { setDefaultForm(f); setRows((x) => x.map((r) => ({ ...r, purchase_form: f }))); }}>
              {f === "vat_margin" ? "VAT marża" : "VAT 23%"}
            </button>
          ))}
          <span className="text-xs text-muted">możesz też zmienić przy każdej rzeczy</span>
        </div>
      )}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="table">
            <thead><tr><th>Rzecz</th><th>Rozmiar</th><th>Rozliczenie</th><th>Twoja kwota (zł)</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td>{r.variant_id ? r.title : <input className="input" value={r.title} onChange={(e) => set(r.key, { title: e.target.value })} placeholder="Marka, model, kolor" />}</td>
                  <td className="w-28">{r.variant_id ? <b>{r.option}</b> : <input className="input" value={r.option} onChange={(e) => set(r.key, { option: e.target.value })} placeholder="np. 42" />}</td>
                  <td className="w-40">
                    <select className={`input ${r.purchase_form ? "" : "border-bad"}`} value={r.purchase_form} onChange={(e) => set(r.key, { purchase_form: e.target.value as Row["purchase_form"] })} aria-label="Rozliczenie">
                      <option value="">wybierz…</option>
                      <option value="vat_margin">VAT marża</option>
                      <option value="vat_23">VAT 23%</option>
                    </select>
                  </td>
                  <td className="w-36"><input className="input" inputMode="decimal" value={r.price} onChange={(e) => set(r.key, { price: e.target.value })} placeholder="np. 450" /></td>
                  <td className="w-10"><button type="button" className="text-bad" onClick={() => setRows((x) => x.filter((y) => y.key !== r.key))} aria-label="Usuń">×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-xs text-muted">Twoja kwota = ile chcesz dostać za rzecz po sprzedaży. Możemy ją zaakceptować albo zaproponować inną.</p>
        </div>
      )}
      <input type="hidden" name="items" value={JSON.stringify(rows.map(({ variant_id, title, option, price, purchase_form }) => ({ variant_id, title, option, price, purchase_form })))} />
      <input className="input" name="note" placeholder="Uwagi (opcjonalnie)" maxLength={500} />
      {state?.error && <p className="text-sm text-bad" role="alert">{state.error}</p>}
      {state?.ok && <p className="text-sm font-medium text-ok" role="status">{state.ok}</p>}
      <button className="btn" disabled={pending || !rows.length || !loc || rows.some((r) => !r.purchase_form)}>{pending ? "Wysyłam…" : `Wyślij zgłoszenie (${rows.length} szt.)`}</button>
      {rows.some((r) => !r.purchase_form) && <p className="text-xs text-bad">Wybierz rozliczenie (VAT marża albo VAT 23%) przy każdej rzeczy.</p>}
    </form>
  );
}
