"use client";

import { SizeChip } from "@/components/SizeChip";
import { OffCatalogAdd } from "@/components/OffCatalogAdd";
import { useActionState, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { SearchInput } from "@/components/SearchInput";
import { createDelivery, searchVariants, type VariantHit } from "./actions";
import { ContractFileInput } from "@/components/ContractFileInput";
import { DateField } from "@/components/DateField";

type Option = { id: string; name: string };
type Loc = Option & { store_id: string; base_warehouse_id: string | null };
type Contract = { id: string; label: string };
type Line = { key: string; variantId: string; title: string; option: string; baseLinked: boolean; quantity: number; price: string; payout: string; identifiers: string };

export function DeliveryForm({
  stores, locations, consignors, contracts, canSeePrices, defaultConsignorId, defaultInTransit = false,
}: { stores: Option[]; locations: Loc[]; consignors: Option[]; contracts: Contract[]; canSeePrices: boolean; defaultConsignorId?: string; defaultInTransit?: boolean }) {
  const [state, action, submitting] = useActionState(createDelivery, null);
  const [storeId, setStoreId] = useState(stores[0]?.id ?? "");
  const storeLocations = useMemo(() => locations.filter((l) => l.store_id === storeId), [locations, storeId]);
  const [locationId, setLocationId] = useState(storeLocations[0]?.id ?? "");
  // Z profilu komisanta („Przyjmij nowe rzeczy”): od razu komis tego komisanta.
  const [ownerType, setOwnerType] = useState<"own" | "consignment">(defaultConsignorId ? "consignment" : "own");
  const [contractMode, setContractMode] = useState<"none" | "existing" | "new">("none");
  // Waluta cen zakupu / komisu (zapisywana przy sztukach i w nowej umowie).
  const [currency, setCurrency] = useState<"PLN" | "EUR">("PLN");
  const curLabel = currency === "EUR" ? "€" : "zł";
  const [inTransit, setInTransit] = useState(defaultInTransit);
  const [lines, setLines] = useState<Line[]>([]);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<VariantHit[]>([]);
  const [searching, startSearch] = useTransition();
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!storeLocations.some((l) => l.id === locationId)) setLocationId(storeLocations[0]?.id ?? "");
  }, [storeLocations, locationId]);

  useEffect(() => {
    if (query.trim().length < 2) {
      setHits([]);
      return;
    }
    const t = setTimeout(() => startSearch(async () => setHits(await searchVariants(query, storeId))), 300);
    return () => clearTimeout(t);
  }, [query, storeId]);

  function addLine(hit: VariantHit, v: VariantHit["variants"][number]) {
    setLines((prev) => {
      const existing = prev.find((l) => l.variantId === v.id);
      if (existing) return prev.map((l) => (l.variantId === v.id ? { ...l, quantity: l.quantity + 1 } : l));
      return [...prev, { key: crypto.randomUUID(), variantId: v.id, title: hit.title, option: v.option, baseLinked: v.baseLinked, quantity: 1, price: "", payout: "", identifiers: "" }];
    });
  }

  /** Odjęcie jednej sztuki rozmiaru (przy zerze – pozycja znika). */
  function removeOne(variantId: string) {
    setLines((prev) => prev.flatMap((l) => (l.variantId !== variantId ? [l] : l.quantity > 1 ? [{ ...l, quantity: l.quantity - 1 }] : [])));
  }

  function update(key: string, patch: Partial<Line>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  const total = lines.reduce((s, l) => s + (Number(l.quantity) || 0), 0);
  const location = locations.find((l) => l.id === locationId);

  /** Wyszukanie (Enter albo kod z aparatu): skan EAN z jednym wynikiem od razu dodaje rozmiar. */
  function find(text: string) {
    if (!text.trim()) return;
    startSearch(async () => {
      const r = await searchVariants(text, storeId);
      setHits(r);
      if (r.length === 1 && r[0].variants.length === 1) {
        addLine(r[0], r[0].variants[0]);
        setQuery("");
      }
    });
  }

  return (
    <form action={action} className="grid gap-5 lg:grid-cols-3">
      <input type="hidden" name="lines" value={JSON.stringify(lines.map(({ variantId, quantity, price, payout, identifiers }) => ({ variantId, quantity: Number(quantity), price, payout, identifiers })))} />

      <div className="min-w-0 space-y-5 lg:col-span-2">
        <section className="card p-4">
          <h2 className="h2 mb-3">1. Produkty</h2>
          <SearchInput
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onScan={(code) => { setQuery(code); find(code); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                find(query);
              }
            }}
            placeholder="Szukaj albo zeskanuj: nazwa, SKU, EAN"
            autoFocus
          />
          {searching && <p className="mt-2 text-sm text-muted">Szukam…</p>}
          {!searching && query.trim().length >= 2 && hits.length === 0 && (
            <p className="mt-2 text-sm text-muted">Nic nie znaleziono w katalogu. Możesz dodać rzecz ręcznie (niżej) albo najpierw w Shopify – wtedy pojawi się tu automatycznie.</p>
          )}
          <div className="mt-2">
            <OffCatalogAdd onAdd={({ variantId, title, option }) => setLines((prev) => [...prev, { key: crypto.randomUUID(), variantId, title: `${title} (spoza Shopify)`, option, baseLinked: false, quantity: 1, price: "", payout: "", identifiers: "" }])} />
          </div>
          <div className="mt-3 space-y-3">
            {hits.map((h) => (
              <div key={h.productId} className="rounded-md border border-line p-3">
                <div className="mb-2 flex items-center gap-3">
                  {h.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={`${h.image}${h.image.includes("?") ? "&" : "?"}width=96`} alt="" className="h-10 w-10 rounded border border-line object-contain" />
                  ) : <div className="h-10 w-10 rounded border border-line bg-panel" />}
                  <div>
                    <div className="font-medium leading-tight">{h.title}</div>
                    <div className="text-xs text-muted">{h.styleSku ?? "bez SKU"}</div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 pt-1">
                  {h.variants.map((v) => (
                    <SizeChip key={v.id} label={v.option} sub={`${v.inStock} szt.`} count={lines.filter((l) => l.variantId === v.id).reduce((n, l) => n + (Number(l.quantity) || 0), 0)}
                      onAdd={() => addLine(h, v)} onRemove={() => removeOne(v.id)} title="Kliknij, żeby dodać sztukę" />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="card overflow-x-auto">
          {canSeePrices && (
            <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5 text-sm">
              <label htmlFor="currency" className="text-muted">Waluta cen</label>
              <select id="currency" name="currency" className="input w-auto py-1" value={currency} onChange={(e) => setCurrency(e.target.value === "EUR" ? "EUR" : "PLN")}>
                <option value="PLN">PLN – złoty</option>
                <option value="EUR">EUR – euro</option>
              </select>
            </div>
          )}
          <table className="table mtable mtable-flow">
            <thead>
              <tr>
                <th>Produkt</th>
                <th>Rozmiar</th>
                <th className="w-20">Ilość</th>
                {canSeePrices && <th className="w-28">Cena zakupu / szt. ({currency})</th>}
                {canSeePrices && ownerType === "consignment" && <th className="w-28">Cena w komisie / szt. ({currency})</th>}
                <th>IMEI / nr seryjne</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 && <tr><td colSpan={7} className="py-8 text-center text-muted">Wyszukaj produkt i kliknij rozmiar.</td></tr>}
              {lines.map((l) => (
                <tr key={l.key}>
                  <td className="min-w-48">{l.title}</td>
                  <td className="font-medium">{l.option}</td>
                  <td><input className="input min-w-[4.5rem] tabular-nums" type="number" min={1} max={500} value={l.quantity} onChange={(e) => update(l.key, { quantity: Math.max(1, Number(e.target.value)) })} aria-label="Ilość" /></td>
                  {canSeePrices && <td><input className="input" inputMode="decimal" value={l.price} onChange={(e) => update(l.key, { price: e.target.value })} placeholder={curLabel} aria-label="Cena zakupu" /></td>}
                  {canSeePrices && ownerType === "consignment" && <td><input className="input" inputMode="decimal" value={l.payout} onChange={(e) => update(l.key, { payout: e.target.value })} placeholder={curLabel} aria-label="Cena w komisie" /></td>}
                  <td><textarea className="input min-w-40" rows={1} value={l.identifiers} onChange={(e) => update(l.key, { identifiers: e.target.value })} placeholder="opcjonalnie, po jednym w linii" aria-label="IMEI lub numery seryjne" /></td>
                  <td><button type="button" className="text-sm text-bad hover:underline" onClick={() => setLines((p) => p.filter((x) => x.key !== l.key))}>Usuń</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <div className="min-w-0 space-y-5">
        <section className="card space-y-3 p-4">
          <h2 className="h2">2. Gdzie</h2>
          <div>
            <label className="label" htmlFor="store_id">Sklep</label>
            <select className="input" id="store_id" name="store_id" value={storeId} onChange={(e) => setStoreId(e.target.value)}>
              {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="location_id">Lokalizacja</label>
            <select className="input" id="location_id" name="location_id" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              {storeLocations.length === 0 && <option value="">Brak lokalizacji – dodaj w Ustawieniach</option>}
              {storeLocations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="shelf">Regał / półka (opcjonalnie)</label>
            <input className="input" id="shelf" name="shelf" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="in_transit" checked={inTransit} onChange={(e) => setInTransit(e.target.checked)} className="h-4 w-4" />
            Towar jeszcze w drodze (nie podnoś stanu w Shopify)
          </label>
        </section>

        <section className="card space-y-3 p-4">
          <h2 className="h2">3. Czyje i na jakiej podstawie</h2>
          <div className="flex gap-2">
            {(["own", "consignment"] as const).map((o) => (
              <label key={o} className={`flex-1 cursor-pointer rounded-md border px-3 py-2 text-center text-sm ${ownerType === o ? "border-accent bg-accent/5 font-medium" : "border-line"}`}>
                <input type="radio" name="owner_type" value={o} checked={ownerType === o} onChange={() => setOwnerType(o)} className="sr-only" />
                {o === "own" ? "Własne" : "Komis"}
              </label>
            ))}
          </div>
          {ownerType === "consignment" && (
            <div>
              <label className="label" htmlFor="consignor_id">Komisant</label>
              <select className="input" id="consignor_id" name="consignor_id" defaultValue={defaultConsignorId ?? ""}>
                <option value="">Wybierz…</option>
                {consignors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          )}
          <div>
            <label className="label" htmlFor="purchase_form">Forma sprzedaży</label>
            <select className="input" id="purchase_form" name="purchase_form" defaultValue="vat_margin">
              <option value="vat_margin">VAT marża</option>
              <option value="vat_23">23% VAT</option>
            </select>
          </div>

          <div className="label mt-2">Umowa</div>
          <div className="grid grid-cols-3 gap-1.5 text-sm">
            {([["none", "Brak"], ["existing", "Istniejąca"], ["new", "Nowa"]] as const).map(([k, label]) => (
              <label key={k} className={`cursor-pointer rounded-md border px-2 py-1.5 text-center ${contractMode === k ? "border-accent bg-accent/5 font-medium" : "border-line"}`}>
                <input type="radio" name="contract_mode" value={k} checked={contractMode === k} onChange={() => setContractMode(k)} className="sr-only" />
                {label}
              </label>
            ))}
          </div>
          {contractMode === "existing" && (
            <select className="input" name="contract_id" defaultValue="">
              <option value="">Wybierz umowę…</option>
              {contracts.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          )}
          {contractMode === "new" && (
            <div className="space-y-2">
              <select className="input" name="contract_type" defaultValue={ownerType === "consignment" ? "consignment" : "purchase"} aria-label="Typ umowy">
                <option value="purchase">umowa kupna</option>
                <option value="consignment">umowa komisowa</option>
                <option value="invoice">FV zakupu</option>
                <option value="other">inna</option>
              </select>
              <input className="input" name="counterparty" placeholder="Od kogo (imię i nazwisko / firma)" aria-label="Od kogo" />
              <div className="grid grid-cols-2 gap-2">
                <DateField name="contract_date" defaultValue={new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" })} aria-label="Data umowy" />
                {canSeePrices && <input className="input" name="contract_amount" inputMode="decimal" placeholder={`Kwota ${curLabel}`} aria-label="Kwota" />}
              </div>
              <ContractFileInput />
            </div>
          )}

          <div>
            <label className="label" htmlFor="note">Notatka do dostawy</label>
            <input className="input" id="note" name="note" />
          </div>
        </section>

        <section className="card space-y-3 p-4">
          {state?.error && <p className="text-sm text-bad">{state.error}</p>}
          <button className="btn w-full" disabled={submitting || !lines.length || !locationId}>
            {submitting ? "Zapisuję…" : `Przyjmij ${total} szt.`}
          </button>
          <p className="text-xs text-muted">{inTransit ? "Sztuki dostaną status „w drodze”." : "Aplikacja podniesie stan w Shopify."} Po zapisie wydrukujesz etykiety.</p>
        </section>
      </div>
    </form>
  );
}
