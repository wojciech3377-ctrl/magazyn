"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { SearchInput } from "@/components/SearchInput";
import { FISCAL_NAME_MAX, receiptName } from "@/lib/fiscal/name";
import { finishPosOrder, pickUnitForVariant, scanUnit, searchCatalog, searchOwnProducts, searchShopifyExtras, searchUnits, type CatalogHit, type CatalogSize, type ExtraHit, type ExtraSize, type OwnProduct, type PosUnit, type ScanChoice, type ScannedUnit } from "./actions";

type UnitLine = PosUnit & { kind: "unit"; key: string; priceInput: string; ptu: string; label: string };
type CustomLine = { kind: "custom"; key: string; name: string; ptu: string; qtyInput: string; priceInput: string; product_id: string | null; save: boolean; note: string };
type Line = UnitLine | CustomLine;
type Ptu = { letter: string; label: string };

const PAYMENTS = [["card", "Karta"], ["cash", "Gotówka"], ["blik", "BLIK"], ["transfer", "Przelew"]] as const;
const fmt = (n: number) => new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN" }).format(n);
const num = (s: string) => Number(s.replace(/\s/g, "").replace(",", ".")) || 0;

/**
 * Kasa: skan / wpisanie kodu albo nazwy (sztuki z magazynu i własne produkty), pozycje wpisane ręcznie
 * spoza magazynu (nazwa, cena, stawka PTU) – np. towar na zamówienie albo usługa.
 */
const SHIP_METHODS = ["Paczkomat InPost", "Kurier InPost", "Kurier DPD", "Kurier DHL", "Poczta Polska", "Inny"];

export function PosForm({ stores, printer, ptu, defaultPtu, ptuFor, printerOnline }: {
  stores: { id: string; name: string }[]; printer: boolean; ptu: Ptu[]; defaultPtu: string;
  /** Domyślne litery PTU dla sztuk: 23% i VAT marża (Ustawienia → Drukarka fiskalna). */
  ptuFor: { vat23: string; margin: string };
  /** Program drukarki odezwał się w ostatnich minutach. */
  printerOnline: boolean;
}) {
  const [ship, setShip] = useState(false);
  const [shipMethod, setShipMethod] = useState(SHIP_METHODS[0]);
  const [state, action, submitting] = useActionState(finishPosOrder, null);
  const [storeId, setStoreId] = useState(stores[0]?.id ?? "");
  const [lines, setLines] = useState<Line[]>([]);
  const [scan, setScan] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  type Hits = { q: string; products: CatalogHit[]; extras: ExtraHit[] | null; own: OwnProduct[]; units: PosUnit[] };
  const [hits, setHits] = useState<Hits | null>(null);
  const searchId = useRef(0);
  const [payment, setPayment] = useState("card");
  const [choices, setChoices] = useState<ScanChoice[] | null>(null);
  const [scanned, setScanned] = useState<ScannedUnit | null>(null);
  const [busy, start] = useTransition();
  const [manual, setManual] = useState({ open: false, name: "", price: "", qty: "1", ptu: defaultPtu, save: false });
  const scanRef = useRef<HTMLInputElement>(null);
  const priceRef = useRef<HTMLInputElement>(null);
  // Katalog w ręcznym dodawaniu: wpisywana nazwa przeszukuje modele ze Shopify i własne produkty.
  const [catalogQ, setCatalogQ] = useState("");
  const [catalog, setCatalog] = useState<{ q: string; products: CatalogHit[]; own: OwnProduct[] } | null>(null);
  const [catalogBusy, startCatalog] = useTransition();

  useEffect(() => {
    const q = catalogQ.trim();
    if (q.length < 2) { setCatalog(null); return; }
    const t = setTimeout(() => startCatalog(async () => {
      const [products, own] = await Promise.all([searchCatalog(q, storeId), searchOwnProducts(q)]);
      setCatalog({ q, products, own });
    }), 300);
    return () => clearTimeout(t);
  }, [catalogQ, storeId]);

  // Wpisywanie nazwy: podpowiedzi na żywo (od 3 znaków, gdy to nie wygląda na kod ze skanera).
  useEffect(() => {
    const q = scan.trim();
    if (q.length < 3 || !/[a-ząćęłńóśźż]\s|[a-ząćęłńóśźż]{3}/i.test(q)) { setHits(null); return; }
    const t = setTimeout(() => searchByName(q), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scan, storeId]);

  /** Wyszukiwanie po nazwie: modele z rozmiarami (katalog), własne produkty, a obok – produkty spoza magazynu ze Shopify (np. rope). */
  function searchByName(q: string) {
    const id = ++searchId.current;
    start(async () => {
      const [products, own] = await Promise.all([searchCatalog(q, storeId, 20), searchOwnProducts(q)]);
      const units = products.length ? [] : await searchUnits(q, storeId);
      if (id !== searchId.current) return;
      setHits({ q, products, own, units, extras: null });
    });
    searchShopifyExtras(q, storeId).then((extras) => {
      if (id === searchId.current) setHits((h) => (h && h.q === q ? { ...h, extras } : { q, products: [], own: [], units: [], extras }));
    }).catch(() => {});
  }

  const unitIds = lines.filter((l): l is UnitLine => l.kind === "unit").map((l) => l.id);

  function addUnit(u: PosUnit) {
    if (unitIds.includes(u.id)) return setMessage({ tone: "error", text: `${u.code} jest już w koszyku.` });
    setLines((prev) => [...prev, { ...u, kind: "unit", key: u.id, priceInput: u.price !== null ? String(u.price) : "", ptu: u.purchaseForm === "vat_23" ? ptuFor.vat23 : ptuFor.margin, label: receiptName(u.title, u.option) }]);
    setMessage({ tone: "ok", text: `Dodano ${u.code} · ${u.title} ${u.option}` });
    setScan("");
    setHits(null);
    searchId.current++;
    setCatalogQ("");
  }

  /** Produkt spoza magazynu ze Shopify (np. sznurówki rope): pozycja z ceną ze sklepu i stawką z reguły wykluczenia. */
  function addExtra(p: ExtraHit, sz: ExtraSize) {
    setLines((prev) => [...prev, {
      kind: "custom", key: crypto.randomUUID(), name: receiptName(p.title, sz.option || ""), ptu: p.vat === "23" ? ptuFor.vat23 : ptuFor.margin,
      qtyInput: "1", priceInput: sz.price !== null ? String(sz.price) : "", product_id: null, save: false, note: "ze Shopify · poza magazynem",
    }]);
    setMessage({ tone: "ok", text: `Dodano ${p.title}${sz.option ? ` ${sz.option}` : ""}` });
    setScan("");
    setHits(null);
    searchId.current++;
  }

  /** Rozmiar z katalogu: jest na stanie → najstarsza sztuka z magazynu; nie ma → pozycja spoza magazynu z ceną z katalogu. */
  function pickCatalog(p: CatalogHit, sz: CatalogSize) {
    if (sz.inStock > 0) {
      start(async () => {
        const r = await pickUnitForVariant(sz.variantId, storeId, unitIds);
        if (r.unit) addUnit(r.unit);
        else setMessage({ tone: "error", text: r.error ?? "Brak sztuki." });
      });
      return;
    }
    setCatalogQ("");
    setManual((m) => ({ ...m, open: true, name: `${p.title} ${sz.option}`.slice(0, 120), price: sz.price !== null ? String(sz.price) : "" }));
    setMessage({ tone: "ok", text: `${p.title} ${sz.option} – brak na stanie. Sprawdź cenę i stawkę PTU, potem „Dodaj do koszyka”.` });
    setTimeout(() => priceRef.current?.focus(), 0);
  }

  function addOwn(p: OwnProduct) {
    if (p.track_stock && p.stock <= 0) return setMessage({ tone: "error", text: `„${p.name}” – brak na stanie.` });
    setLines((prev) => [...prev, { kind: "custom", key: crypto.randomUUID(), name: p.name, ptu: p.ptu, qtyInput: "1", priceInput: p.price !== null ? String(p.price) : "", product_id: p.id, save: false, note: p.track_stock ? `własny produkt · stan ${p.stock}` : "własny produkt" }]);
    setMessage({ tone: "ok", text: `Dodano ${p.name}` });
    setScan("");
    setHits(null);
    setCatalogQ("");
  }

  function addManual() {
    if (!manual.name.trim()) return setMessage({ tone: "error", text: "Wpisz nazwę pozycji." });
    if (!(num(manual.price) > 0)) return setMessage({ tone: "error", text: "Wpisz cenę pozycji." });
    setLines((prev) => [...prev, { kind: "custom", key: crypto.randomUUID(), name: manual.name.trim(), ptu: manual.ptu, qtyInput: manual.qty || "1", priceInput: manual.price, product_id: null, save: manual.save, note: manual.save ? "spoza magazynu · zapisze się jako własny produkt" : "spoza magazynu" }]);
    setManual({ open: true, name: "", price: "", qty: "1", ptu: manual.ptu, save: false });
    setCatalogQ("");
    setMessage({ tone: "ok", text: "Dodano pozycję spoza magazynu." });
  }

  function onScan(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    lookup(scan);
  }

  /** Kod ze skanera, aparatu albo wpisany: sztuka, SKU / EAN (wybór rozmiaru) albo nazwa. */
  function lookup(code: string) {
    if (!code.trim()) return;
    start(async () => {
      const r = await scanUnit(code, storeId, unitIds);
      setChoices(null);
      setScanned(null);
      if (r.unit) addUnit(r.unit);
      else if (r.choices) {
        setChoices(r.choices);
        setScanned(r.scanned ?? null);
        setScan("");
        setMessage(r.scanned
          ? { tone: "ok", text: r.scanned.unit ? `Zeskanowano ${r.scanned.code} – wybierz rozmiar (zeskanowany jest zaznaczony).` : `Sztuka ${r.scanned.code} jest już sprzedana albo w koszyku – wybierz rozmiar z magazynu.` }
          : { tone: "ok", text: "Wybierz rozmiar." });
      } else {
        // Nie kod – szukamy po nazwie: modele z rozmiarami, własne produkty i produkty spoza magazynu ze Shopify.
        setMessage(null);
        searchByName(code.trim());
      }
      scanRef.current?.focus();
    });
  }

  function pick(ch: ScanChoice) {
    if (scanned?.unit && ch.variantId === scanned.variantId && !unitIds.includes(scanned.unit.id)) {
      addUnit(scanned.unit);
      setChoices(null);
      setScanned(null);
      scanRef.current?.focus();
      return;
    }
    start(async () => {
      const r = await pickUnitForVariant(ch.variantId, storeId, unitIds);
      if (r.unit) { addUnit(r.unit); setChoices(null); setScanned(null); } else setMessage({ tone: "error", text: r.error ?? "Brak sztuki." });
      scanRef.current?.focus();
    });
  }

  const setLine = (key: string, patch: Partial<UnitLine> & Partial<CustomLine>) => setLines((p) => p.map((x) => (x.key === key ? ({ ...x, ...patch } as Line) : x)));
  const total = lines.reduce((s, l) => s + num(l.priceInput) * (l.kind === "custom" ? num(l.qtyInput) || 1 : 1), 0);
  const count = lines.reduce((s, l) => s + (l.kind === "custom" ? num(l.qtyInput) || 1 : 1), 0);
  const items = lines.map((l) => (l.kind === "unit"
    ? { unit_id: l.id, price: l.priceInput, ptu: l.ptu, ...(l.label.trim() && l.label.trim() !== receiptName(l.title, l.option) ? { name: l.label.trim() } : {}) }
    : { name: l.name, ptu: l.ptu, price: l.priceInput, quantity: l.qtyInput, product_id: l.product_id, save: l.save }));
  const ptuText = (letter: string) => ptu.find((p) => p.letter === letter)?.label ?? letter;

  return (
    <form action={action} className="grid gap-5 lg:grid-cols-3">
      <input type="hidden" name="items" value={JSON.stringify(items)} />
      <input type="hidden" name="payment" value={payment} />

      <div className="min-w-0 space-y-5 lg:col-span-2">
        <section className="card space-y-3 p-4">
          <label className="label" htmlFor="scan">Skanuj kod albo wpisz nazwę</label>
          <SearchInput
            ref={scanRef}
            id="scan"
            large
            className="font-mono"
            value={scan}
            onChange={(e) => setScan(e.target.value)}
            onKeyDown={onScan}
            onScan={(code) => { setScan(code); lookup(code); }}
            continuous
            placeholder="Kod S000123, IMEI, SKU, EAN albo nazwa"
            autoFocus
          />
          {busy && <p className="text-xs text-muted">Szukam…</p>}
          {message && <p className={`text-sm ${message.tone === "ok" ? "text-ok" : "text-bad"}`}>{message.text}</p>}
          {choices && (
            <div className="rounded-xl border border-line p-3">
              <div className="mb-2 flex items-start gap-2">
                <div className="flex-1 text-sm font-medium">{choices[0]?.title}</div>
                <button type="button" className="text-xs text-muted hover:text-ink" onClick={() => { setChoices(null); setScanned(null); scanRef.current?.focus(); }}>Zamknij ✕</button>
              </div>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-1.5">
                {choices.map((ch) => {
                  const isScanned = scanned?.variantId === ch.variantId;
                  return (
                    <button type="button" key={ch.variantId} disabled={ch.inStock === 0} onClick={() => pick(ch)}
                      className={`flex flex-col items-center rounded-lg border px-2 py-2 text-sm hover:border-accent disabled:opacity-35 ${isScanned ? "border-accent bg-accent-soft ring-2 ring-accent/40" : "border-line"}`}>
                      <b className="text-base">{ch.option}</b>
                      <span className="text-xs tabular-nums text-muted">{ch.inStock ? `${ch.inStock} szt.` : "brak"}{ch.price !== null ? ` · ${fmt(ch.price)}` : ""}</span>
                      {isScanned && <span className="text-[10px] font-semibold uppercase tracking-wide text-accent">zeskanowany</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {hits && (
            <div className="max-h-[32rem] space-y-2 overflow-y-auto rounded-xl border border-line bg-slate-50/60 p-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs text-muted">
                <span className="flex items-center gap-1"><i className="h-2.5 w-2.5 rounded-sm border border-emerald-400 bg-emerald-100" /> na miejscu</span>
                <span className="flex items-center gap-1"><i className="h-2.5 w-2.5 rounded-sm border border-amber-300 bg-amber-50" /> w innym sklepie</span>
                <span className="flex items-center gap-1"><i className="h-2.5 w-2.5 rounded-sm border border-line bg-white" /> brak (dodasz jako pozycję z ceną)</span>
                <button type="button" className="ml-auto hover:text-ink" onClick={() => { setHits(null); searchId.current++; }}>zamknij ✕</button>
              </div>
              {hits.own.map((p) => (
                <div key={p.id} className="flex items-center gap-3 rounded-lg border border-line bg-white px-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium leading-snug">{p.name}</span>
                    <span className="text-xs text-muted">własny produkt · PTU {ptuText(p.ptu)}{p.track_stock ? ` · stan ${p.stock}` : " · bez stanu"}</span>
                  </span>
                  <span className="tabular-nums">{p.price !== null ? fmt(p.price) : "–"}</span>
                  <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={() => addOwn(p)}>Dodaj</button>
                </div>
              ))}
              {hits.products.map((p) => {
                const here = p.sizes.reduce((n, x) => n + x.here, 0);
                const all = p.sizes.reduce((n, x) => n + x.inStock, 0);
                return (
                  <div key={p.productId} className="rounded-lg border border-line bg-white p-2.5">
                    <div className="mb-2 flex items-center gap-2.5">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {p.image ? <img src={`${p.image}${p.image.includes("?") ? "&" : "?"}width=96`} alt="" className="h-11 w-11 shrink-0 rounded-md border border-line bg-white object-contain" /> : <span className="h-11 w-11 shrink-0 rounded-md bg-slate-100" />}
                      <span className="min-w-0">
                        <span className="block font-medium leading-snug">{p.title}</span>
                        <span className="text-xs text-muted">{p.sku ?? "bez SKU"} · na miejscu {here} szt.{all > here ? ` · w innych ${all - here}` : ""}</span>
                      </span>
                    </div>
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(5.25rem,1fr))] gap-1.5">
                      {p.sizes.map((sz) => (
                        <button type="button" key={sz.variantId} onClick={() => pickCatalog(p, sz)} title={sz.sku ?? undefined}
                          className={`rounded-lg border px-2 py-1.5 text-center text-xs transition-colors ${sz.here > 0 ? "border-emerald-400 bg-emerald-100 text-emerald-950 hover:border-emerald-600" : sz.inStock > 0 ? "border-amber-300 bg-amber-50 hover:border-amber-500" : "border-line bg-white text-slate-400 hover:border-accent"}`}>
                          <b className="block text-sm">{sz.option}</b>
                          <span className="block tabular-nums">{sz.here > 0 ? `${sz.here} szt.` : sz.inStock > 0 ? `inny sklep ${sz.inStock}` : "brak"}</span>
                          {sz.price !== null && <span className="block tabular-nums opacity-80">{fmt(sz.price)}</span>}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
              {hits.units.map((u) => (
                <div key={u.id} className="flex items-center gap-3 rounded-lg border border-line bg-white px-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium leading-snug">{u.title} · {u.option}</span>
                    <span className="text-xs text-muted">{u.code}{u.identifier ? ` · ${u.identifier}` : ""} · {u.location}{u.owner ? ` · komis ${u.owner}` : ""}</span>
                  </span>
                  <span className="tabular-nums">{u.price !== null ? fmt(u.price) : "–"}</span>
                  <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={() => addUnit(u)} disabled={unitIds.includes(u.id)}>Dodaj</button>
                </div>
              ))}
              {hits.extras === null && <p className="px-1 text-xs text-muted">Szukam też w Shopify (produkty spoza magazynu, np. rope)…</p>}
              {hits.extras?.map((p) => (
                <div key={p.id} className="rounded-lg border border-line bg-white p-2.5">
                  <div className="mb-2 flex items-center gap-2.5">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {p.image ? <img src={`${p.image}${p.image.includes("?") ? "&" : "?"}width=96`} alt="" className="h-11 w-11 shrink-0 rounded-md border border-line bg-white object-contain" /> : <span className="h-11 w-11 shrink-0 rounded-md bg-slate-100" />}
                    <span className="min-w-0">
                      <span className="block font-medium leading-snug">{p.title}</span>
                      <span className="text-xs text-muted">ze Shopify · poza magazynem · {p.vat === "23" ? "VAT 23%" : "VAT marża"}</span>
                    </span>
                  </div>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(5.25rem,1fr))] gap-1.5">
                    {p.sizes.map((sz) => {
                      const on = sz.available === null || sz.available > 0;
                      return (
                        <button type="button" key={sz.id} onClick={() => addExtra(p, sz)}
                          className={`rounded-lg border px-2 py-1.5 text-center text-xs transition-colors ${on ? "border-emerald-400 bg-emerald-100 text-emerald-950 hover:border-emerald-600" : "border-line bg-white text-slate-400 hover:border-accent"}`}>
                          <b className="block text-sm">{sz.option || "Dodaj"}</b>
                          <span className="block tabular-nums">{sz.available === null ? "bez stanu" : sz.available > 0 ? `${sz.available} szt.` : "brak"}</span>
                          {sz.price !== null && <span className="block tabular-nums opacity-80">{fmt(sz.price)}</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
              {!busy && hits.extras !== null && !hits.products.length && !hits.own.length && !hits.units.length && !hits.extras.length && (
                <p className="px-1 py-2 text-sm text-muted">Nie znaleziono „{hits.q}”. Możesz dodać pozycję ręcznie poniżej.</p>
              )}
            </div>
          )}

          <div className="rounded-xl border border-dashed border-line">
            <button type="button" className="flex w-full items-center justify-between px-3 py-2.5 text-left text-sm font-medium text-ink" onClick={() => setManual((m) => ({ ...m, open: !m.open }))} aria-expanded={manual.open}>
              Dodaj ręcznie – z katalogu albo spoza magazynu
              <span className="text-xs font-normal text-muted">{manual.open ? "schowaj" : "szukaj w katalogu, towar na zamówienie, usługa"}</span>
            </button>
            {manual.open && (
              <div className="space-y-3 border-t border-line p-3">
                <div className="grid gap-2 sm:grid-cols-[1fr_7rem_5rem_9rem]">
                  <SearchInput value={manual.name} onChange={(e) => { setManual({ ...manual, name: e.target.value }); setCatalogQ(e.target.value); }} placeholder="Szukaj w katalogu albo wpisz nazwę" aria-label="Nazwa albo wyszukiwanie w katalogu" maxLength={120}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addManual(); } if (e.key === "Escape") setCatalogQ(""); }}
                    onScan={(code) => { setManual((m) => ({ ...m, open: true, name: code })); setCatalogQ(code); }} />
                  <input ref={priceRef} className="input tabular-nums" inputMode="decimal" value={manual.price} onChange={(e) => setManual({ ...manual, price: e.target.value })} placeholder="Cena zł" aria-label="Cena"
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addManual(); } }} />
                  <input className="input tabular-nums" inputMode="decimal" value={manual.qty} onChange={(e) => setManual({ ...manual, qty: e.target.value })} aria-label="Ilość" title="Ilość" />
                  <select className="input" value={manual.ptu} onChange={(e) => setManual({ ...manual, ptu: e.target.value })} aria-label="Stawka PTU">
                    {ptu.map((p) => <option key={p.letter} value={p.letter}>PTU {p.label}</option>)}
                  </select>
                </div>
                {catalogBusy && <p className="text-xs text-muted">Szukam w katalogu…</p>}
                {catalog && catalogQ.trim() && (
                  catalog.products.length || catalog.own.length ? (
                    <div className="max-h-96 space-y-2 overflow-y-auto rounded-xl border border-line bg-slate-50/60 p-2">
                      <div className="flex items-center justify-between px-1 text-xs text-muted">
                        <span>Katalog – kliknij rozmiar. Na stanie: dodaje sztukę z magazynu; brak: uzupełnia nazwę i cenę.</span>
                        <button type="button" className="hover:text-ink" onClick={() => setCatalogQ("")}>zamknij</button>
                      </div>
                      {catalog.own.map((o) => (
                        <div key={o.id} className="flex items-center gap-3 rounded-lg border border-line bg-white px-3 py-2">
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">{o.name}</span>
                            <span className="text-xs text-muted">własny produkt · PTU {ptuText(o.ptu)}{o.track_stock ? ` · stan ${o.stock}` : ""}</span>
                          </span>
                          <span className="text-sm tabular-nums">{o.price !== null ? fmt(o.price) : "–"}</span>
                          <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={() => addOwn(o)}>Dodaj</button>
                        </div>
                      ))}
                      {catalog.products.map((p) => (
                        <div key={p.productId} className="rounded-lg border border-line bg-white p-2.5">
                          <div className="mb-2 flex items-center gap-2.5">
                            {p.image ? <img src={`${p.image}${p.image.includes("?") ? "&" : "?"}width=96`} alt="" className="h-9 w-9 shrink-0 rounded-md border border-line bg-white object-contain" /> : <span className="h-9 w-9 shrink-0 rounded-md bg-slate-100" />}
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-medium">{p.title}</span>
                              <span className="text-xs text-muted">{p.sku ?? "bez SKU"} · na stanie {p.sizes.reduce((n, x) => n + x.inStock, 0)} szt.</span>
                            </span>
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {p.sizes.map((sz) => (
                              <button type="button" key={sz.variantId} onClick={() => pickCatalog(p, sz)} title={sz.sku ?? undefined}
                                className={`rounded-lg border px-2 py-1 text-left text-xs transition-colors ${sz.here > 0 ? "border-emerald-400 bg-emerald-100 hover:border-emerald-600" : sz.inStock > 0 ? "border-amber-300 bg-amber-50 hover:border-amber-500" : "border-line hover:border-accent"}`}>
                                <b className="text-sm">{sz.option}</b>
                                <span className="block tabular-nums text-muted">{sz.price !== null ? fmt(sz.price) : "bez ceny"} · {sz.here > 0 ? `${sz.here} szt.` : sz.inStock > 0 ? `inny sklep ${sz.inStock}` : "brak"}</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : !catalogBusy && <p className="text-xs text-muted">Nie ma w katalogu „{catalog.q}” – dodasz ją jako własną pozycję.</p>
                )}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={manual.save} onChange={(e) => setManual({ ...manual, save: e.target.checked })} /> zapisz jako własny produkt (będzie w wyszukiwaniu)</label>
                  <button type="button" className="btn-secondary" onClick={addManual}>Dodaj do koszyka</button>
                </div>
                <p className="text-xs text-muted">Pozycja nie trafia do magazynu ani do Shopify – po wydruku paragonu jest w JPK.</p>
              </div>
            )}
          </div>
        </section>

        <section className="card">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted">
            <span>Koszyk</span><span>stawka VAT · ilość · cena</span>
          </div>
          {lines.length === 0 && <p className="py-8 text-center text-sm text-muted">Zeskanuj pierwszą sztukę albo wpisz nazwę.</p>}
          <ul className="divide-y divide-line">
            {lines.map((l) => (
              <li key={l.key} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                <div className="min-w-0 flex-[1_1_16rem]">
                  {/* Nazwa na paragonie – można ją zmienić (drukarka fiskalna przyjmuje do 40 znaków; rozmiar zostaje na końcu). */}
                  {l.kind === "unit" ? (
                    <>
                      <input className="input py-1.5 font-medium" value={l.label} maxLength={FISCAL_NAME_MAX} aria-label={`Nazwa na paragonie ${l.code}`}
                        onChange={(e) => setLine(l.key, { label: e.target.value })} />
                      <div className="mt-0.5 text-xs text-muted">
                        <span className="font-mono">{l.code}</span>{l.identifier ? ` · ${l.identifier}` : ""} · {l.title} · <b>{l.option}</b>{l.owner ? ` · komis ${l.owner}` : ""}
                        <span className="ml-1 tabular-nums">({l.label.length}/{FISCAL_NAME_MAX})</span>
                      </div>
                    </>
                  ) : (
                    <>
                      <input className="input py-1.5 font-medium" value={l.name} maxLength={120} aria-label="Nazwa na paragonie"
                        onChange={(e) => setLine(l.key, { name: e.target.value })} />
                      <div className="mt-0.5 text-xs text-muted">{l.note}{l.name.length > FISCAL_NAME_MAX && <span className="text-warn"> · na paragonie {FISCAL_NAME_MAX} znaków</span>}</div>
                    </>
                  )}
                </div>
                <div className="flex flex-[0_1_auto] items-center gap-2">
                  <div className="w-44"><PtuSelect value={l.ptu} ptu={ptu} label={`Stawka VAT ${l.kind === "unit" ? l.code : l.name}`} onChange={(v) => setLine(l.key, { ptu: v })} /></div>
                  {l.kind === "unit"
                    ? <span className="w-14 text-center text-sm text-muted">1 szt.</span>
                    : <input className="input w-14 text-center tabular-nums" inputMode="decimal" value={l.qtyInput} aria-label={`Ilość ${l.name}`} onChange={(e) => setLine(l.key, { qtyInput: e.target.value })} />}
                  <input className="input w-24 text-right tabular-nums" inputMode="decimal" value={l.priceInput} aria-label="Cena" onChange={(e) => setLine(l.key, { priceInput: e.target.value })} />
                  <button type="button" className="btn-ghost px-2 text-bad" onClick={() => setLines((p) => p.filter((x) => x.key !== l.key))} aria-label="Usuń z koszyka">Usuń</button>
                </div>
              </li>
            ))}
          </ul>
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
                  className={`rounded-lg border px-2 py-2 text-sm transition-colors ${payment === k ? "border-accent bg-accent-soft font-medium text-accent" : "border-line hover:bg-slate-50"}`}>
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
            <span className="text-sm text-muted">{count} {count === 1 ? "pozycja" : "pozycji"}</span>
            <span className="text-2xl font-semibold tabular-nums">{fmt(total)}</span>
          </div>
          {state?.error && <p className="text-sm text-bad">{state.error}</p>}
          {ship ? (
            <>
              <button className="btn w-full whitespace-normal py-3 text-base leading-tight" name="receipt" value="ship" disabled={submitting || !lines.length}>{submitting ? "Zapisuję…" : "Zakończ – wysyłka i paragon PDF"}</button>
              <p className="text-xs text-muted">Bez paragonu fiskalnego. Paragon PDF otworzy się do wydruku, zamówienie pojawi się w Sprzedaż → Zamówienia.</p>
            </>
          ) : (
            <>
              <button className="btn w-full whitespace-normal py-3 text-base leading-tight" name="receipt" value="1" disabled={submitting || !lines.length}>{submitting ? "Zapisuję…" : "Zakończ i wystaw paragon"}</button>
              <button className="btn-ghost h-auto w-full whitespace-normal py-1.5 text-xs leading-tight" name="receipt" value="0" disabled={submitting || !lines.length}>Zakończ bez paragonu (np. na fakturę)</button>
              <button className="btn-secondary w-full whitespace-normal py-2.5 leading-tight" name="receipt" value="pdf" disabled={submitting || !lines.length}>Drukuj paragon PDF</button>
              <p className="text-xs text-muted">„Drukuj paragon PDF” – tylko paragon PDF do wydruku, <b>bez paragonu fiskalnego</b> (poza JPK). Paragon fiskalny drukuje tylko „Zakończ i wystaw paragon”.</p>
            </>
          )}
          <p className="text-xs text-muted">
            Sztuki z magazynu zmienią status na „sprzedana”, a stan w Shopify spadnie o 1 za każdą.{" "}
            {!printer ? "Drukarka fiskalna nie jest jeszcze podłączona (Ustawienia → Drukarka fiskalna) – paragon trafi do kolejki i wydrukuje się po podłączeniu."
              : printerOnline ? "Paragon wydrukuje się od razu na drukarce fiskalnej." : ""}
          </p>
          {printer && !printerOnline && !ship && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">Program drukarki fiskalnej nie odpowiada od kilku minut – sprawdź, czy komputer przy drukarce jest włączony. Paragon poczeka w kolejce i wydrukuje się, gdy program wróci.</p>
          )}
        </section>
        <section className={`card p-4 ${ship ? "border-accent/50" : ""}`}>
          <input type="hidden" name="ship" value={ship ? "1" : "0"} />
          <label className="flex cursor-pointer items-start gap-3">
            <input type="checkbox" checked={ship} onChange={(e) => setShip(e.target.checked)} className="mt-1 h-5 w-5 accent-[var(--color-accent)]" />
            <span>
              <span className="block font-semibold">Wysyłka</span>
              <span className="block text-sm text-muted">Bez paragonu fiskalnego: paragon PDF i zamówienie w Sprzedaż → Zamówienia (etykieta). <b>Nie wchodzi do JPK</b>, umowy sztuk wracają do niewykorzystanych.</span>
            </span>
          </label>
          {ship && (
            <div className="mt-3 grid gap-3">
              <div><label className="label" htmlFor="ship_store">Wysyłka ze sklepu</label>
                <select id="ship_store" className="input" name="ship_store" value={storeId} onChange={(e) => setStoreId(e.target.value)}>{stores.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
              <div><label className="label" htmlFor="ship_method">Sposób wysyłki</label>
                <select id="ship_method" className="input" name="ship_method" value={shipMethod} onChange={(e) => setShipMethod(e.target.value)}>
                  {SHIP_METHODS.map((m) => <option key={m}>{m}</option>)}
                </select></div>
              {/paczkomat/i.test(shipMethod) && <div><label className="label" htmlFor="ship_point">Kod paczkomatu</label><input id="ship_point" className="input font-mono uppercase" name="ship_point" placeholder="np. WAW123M" required /></div>}
              <div><label className="label" htmlFor="ship_name">Odbiorca</label><input id="ship_name" className="input" name="ship_name" autoComplete="name" required /></div>
              <div><label className="label" htmlFor="ship_phone">Telefon</label><input id="ship_phone" className="input" name="ship_phone" inputMode="tel" autoComplete="tel" required /></div>
              <div><label className="label" htmlFor="ship_email">E-mail (opcjonalnie)</label><input id="ship_email" className="input" type="email" name="ship_email" autoComplete="email" /></div>
              {!/paczkomat/i.test(shipMethod) && (
                <>
                  <div><label className="label" htmlFor="ship_street">Ulica i numer</label><input id="ship_street" className="input" name="ship_street" autoComplete="address-line1" required /></div>
                  <div className="grid grid-cols-[7rem_1fr] gap-2">
                    <div><label className="label" htmlFor="ship_zip">Kod</label><input id="ship_zip" className="input" name="ship_zip" autoComplete="postal-code" placeholder="00-000" required /></div>
                    <div><label className="label" htmlFor="ship_city">Miasto</label><input id="ship_city" className="input" name="ship_city" autoComplete="address-level2" required /></div>
                  </div>
                </>
              )}
              <div><label className="label" htmlFor="ship_country">Kraj</label><input id="ship_country" className="input uppercase" name="ship_country" defaultValue="PL" maxLength={2} /></div>
              <div><label className="label" htmlFor="ship_note">Uwagi do wysyłki</label><input id="ship_note" className="input" name="ship_note" /></div>
              <button className="btn w-full whitespace-normal py-3 text-base leading-tight" name="receipt" value="ship" disabled={submitting || !lines.length}>{submitting ? "Zapisuję…" : "Zakończ – wysyłka i paragon PDF"}</button>
            </div>
          )}
        </section>
      </div>
    </form>
  );
}

function PtuSelect({ value, ptu, label, onChange }: { value: string; ptu: Ptu[]; label: string; onChange: (v: string) => void }) {
  return (
    <select className="input py-1.5 text-sm" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      {ptu.map((p) => <option key={p.letter} value={p.letter}>{p.label}</option>)}
    </select>
  );
}
