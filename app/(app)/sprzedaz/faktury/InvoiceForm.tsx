"use client";

import { useActionState, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { SearchInput } from "@/components/SearchInput";
import Link from "next/link";
import { createInvoiceAction, issueReceiptAction, lookupNipAction, previewReceiptAction, searchCustomersAction, searchInvoiceItemsAction, type CustomerHit, type InvoiceFormState, type InvoiceItemHit, type ReceiptState } from "./actions";
import type { InvoiceDraft } from "@/lib/invoices/service";
import { printPdf } from "@/components/PrintPdf";

type Row = { name: string; quantity: string; unit: string; price: string; vat: "23" | "margin"; unit_id?: string | null; sale_id?: string | null; pos_item_id?: string | null; checkVat?: boolean };

const PAYMENTS: [string, string][] = [["card", "Karta / płatność online"], ["transfer", "Przelew"], ["cash", "Gotówka / pobranie"], ["mobile", "BLIK / płatność mobilna"]];
const pl = (n: number) => new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN" }).format(n);
const num = (v: string) => Number(v.replace(",", ".")) || 0;

export function InvoiceForm({ draft, ksefReady, receipt = false, stores = [], defaultStore }: { draft: InvoiceDraft; ksefReady: boolean; receipt?: boolean; stores?: { id: string; name: string }[]; defaultStore?: string }) {
  // Paragon bez zamówienia: opcja „Wysyłka” – zamówienie do Sprzedaż → Zamówienia (poza JPK).
  const canShip = receipt && !draft.orderId && !draft.posOrderId && stores.length > 0;
  const [ship, setShip] = useState(false);
  const [shipMethod, setShipMethod] = useState("Paczkomat InPost");
  const [invState, invAction, invPending] = useActionState<InvoiceFormState, FormData>(createInvoiceAction, null);
  const [parState, parAction, parPending] = useActionState<ReceiptState, FormData>(issueReceiptAction, null);
  const state = receipt ? parState : invState;
  const action = receipt ? parAction : invAction;
  const pending = receipt ? parPending : invPending;
  // Paragon: po wystawieniu od razu systemowe okno drukowania.
  const printed = useRef<string | null>(null);
  useEffect(() => {
    if (receipt && parState?.id && printed.current !== parState.id) {
      printed.current = parState.id;
      printPdf(`/api/faktury/${parState.id}/pdf`);
    }
  }, [receipt, parState]);
  const [preview, setPreview] = useState<{ busy: boolean; url: string | null; error: string | null }>({ busy: false, url: null, error: null });
  async function showPreview() {
    if (!formRef.current) return;
    setPreview({ busy: true, url: null, error: null });
    const r = await previewReceiptAction(new FormData(formRef.current));
    if (r.error || !r.pdf) return setPreview({ busy: false, url: null, error: r.error ?? "Nie udało się przygotować podglądu." });
    const bytes = Uint8Array.from(atob(r.pdf), (c) => c.charCodeAt(0));
    setPreview({ busy: false, url: URL.createObjectURL(new Blob([bytes], { type: "application/pdf" })), error: null });
  }
  const [company, setCompany] = useState(!!draft.buyer.company);
  const [paid, setPaid] = useState(draft.paid);
  const formRef = useRef<HTMLFormElement>(null);
  const [lookup, setLookup] = useState<{ busy: boolean; msg: string | null; error: boolean }>({ busy: false, msg: null, error: false });
  async function fetchNip() {
    const form = formRef.current;
    const nip = (form?.elements.namedItem("nip") as HTMLInputElement | null)?.value ?? "";
    setLookup({ busy: true, msg: null, error: false });
    const r = await lookupNipAction(nip);
    if (!r.ok) {
      setLookup({ busy: false, msg: r.error, error: true });
      return;
    }
    const setField = (name: string, value: string) => {
      const el = form?.elements.namedItem(name) as HTMLInputElement | null;
      if (el) el.value = value;
    };
    setField("name", r.name);
    setField("address1", r.address1);
    setField("address2", r.address2);
    setField("country", "PL");
    setLookup({ busy: false, msg: `Uzupełniono z: ${r.source}${r.note ? ` · ${r.note}` : ""}`, error: !!r.note });
  }
  // Zapisani nabywcy: wyszukiwanie i wstawienie danych do formularza.
  const [custQ, setCustQ] = useState("");
  const [custHits, setCustHits] = useState<CustomerHit[]>([]);
  const [custOpen, setCustOpen] = useState(false);
  const [, startSearch] = useTransition();
  useEffect(() => {
    if (!custOpen) return;
    const t = setTimeout(() => startSearch(async () => setCustHits(await searchCustomersAction(custQ))), 250);
    return () => clearTimeout(t);
  }, [custQ, custOpen]);
  function pickCustomer(c: CustomerHit) {
    setCompany(c.company);
    setCustOpen(false);
    setCustQ("");
    // Pole NIP pojawia się dopiero po przełączeniu na firmę – uzupełniamy po wyrenderowaniu.
    setTimeout(() => {
      const form = formRef.current;
      const set = (name: string, value: string | null) => {
        const el = form?.elements.namedItem(name) as HTMLInputElement | null;
        if (el) el.value = value ?? "";
      };
      set("name", c.name);
      set("nip", c.nip);
      set("address1", c.address1);
      set("address2", c.address2);
      set("country", c.country || "PL");
      set("email", c.email);
      setLookup({ busy: false, msg: "Dane z zapisanych nabywców.", error: false });
    }, 0);
  }
  const [rows, setRows] = useState<Row[]>(draft.items.length ? draft.items.map((i) => ({
    name: i.name, quantity: String(i.quantity), unit: i.unit, price: i.unit_price_gross.toFixed(2), vat: i.vat,
    unit_id: i.unit_id, sale_id: i.sale_id, pos_item_id: i.pos_item_id, checkVat: i.checkVat,
  })) : [{ name: "", quantity: "1", unit: "szt.", price: "", vat: "margin" }]);

  // Pozycje z magazynu / katalogu.
  const [itemQ, setItemQ] = useState("");
  const [itemHits, setItemHits] = useState<InvoiceItemHit[]>([]);
  const [, startItems] = useTransition();
  useEffect(() => {
    if (itemQ.trim().length < 2) return setItemHits([]);
    const t = setTimeout(() => startItems(async () => setItemHits(await searchInvoiceItemsAction(itemQ))), 300);
    return () => clearTimeout(t);
  }, [itemQ]);
  function addItem(h: InvoiceItemHit) {
    const row: Row = { name: h.name, quantity: "1", unit: "szt.", price: h.price !== null ? h.price.toFixed(2) : "", vat: h.vat, unit_id: h.unit_id, checkVat: h.checkVat };
    setRows((rs) => {
      if (h.unit_id && rs.some((r) => r.unit_id === h.unit_id)) return rs;
      const blank = rs.length === 1 && !rs[0].name && !rs[0].price;
      return blank ? [row] : [...rs, row];
    });
    setItemQ("");
    setItemHits([]);
  }
  const totals = useMemo(() => {
    const g23 = rows.filter((r) => r.vat === "23").reduce((s, r) => s + num(r.price) * num(r.quantity), 0);
    const margin = rows.filter((r) => r.vat === "margin").reduce((s, r) => s + num(r.price) * num(r.quantity), 0);
    const net = Math.round((g23 / 1.23) * 100) / 100;
    return { g23, net, vat: Math.round((g23 - net) * 100) / 100, margin, total: g23 + margin };
  }, [rows]);
  const set = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const itemsJson = JSON.stringify(rows.map((r) => ({
    name: r.name, quantity: num(r.quantity), unit: r.unit, unit_price_gross: num(r.price), vat: r.vat, unit_id: r.unit_id, sale_id: r.sale_id, pos_item_id: r.pos_item_id, checkVat: r.checkVat,
  })));
  const needsCheck = rows.some((r) => r.checkVat);

  return (
    <form ref={formRef} action={action} className="space-y-5">
      <input type="hidden" name="items" value={itemsJson} />
      <input type="hidden" name="company" value={company ? "1" : "0"} />
      <input type="hidden" name="paid" value={paid ? "1" : "0"} />
      {draft.orderId && <input type="hidden" name="order_id" value={draft.orderId} />}
      {draft.posOrderId && <input type="hidden" name="pos_order_id" value={draft.posOrderId} />}
      {draft.consignorShipmentId && <input type="hidden" name="consignor_shipment_id" value={draft.consignorShipmentId} />}

      {receipt ? (
        <section className="card border-sky-200 bg-sky-50/60 p-4 text-sm">
          <b>Paragon dla osoby prywatnej</b> – dokument w formie faktury do druku, bez danych nabywcy. Nie trafia do KSeF.
          Numer nadawany przy wydruku: <span className="font-mono">PAR/{draft.issueDate.slice(5, 7)}/kolejny</span> (od 1 w każdym miesiącu).
        </section>
      ) : (
      <section className="card p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="h2 mr-2">Nabywca</h2>
          <div className="relative order-last w-full sm:order-none sm:ml-auto sm:w-72">
            <input className="input" value={custQ} placeholder="Zapisani nabywcy – szukaj…" aria-label="Szukaj zapisanego nabywcy"
              onFocus={() => setCustOpen(true)} onBlur={() => setTimeout(() => setCustOpen(false), 150)} onChange={(e) => setCustQ(e.target.value)} />
            {custOpen && custHits.length > 0 && (
              <ul className="absolute right-0 z-30 mt-1 max-h-72 w-full overflow-auto rounded-md border border-line bg-white py-1 text-sm shadow-lg">
                {custHits.map((c) => (
                  <li key={c.id}>
                    <button type="button" className="block w-full px-3 py-1.5 text-left hover:bg-panel" onMouseDown={(e) => e.preventDefault()} onClick={() => pickCustomer(c)}>
                      <span className="font-medium">{c.name}</span>
                      <span className="block text-xs text-muted">{[c.nip ? `NIP ${c.nip}` : "osoba prywatna", c.address2, c.email].filter(Boolean).join(" · ")}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {[false, true].map((c) => (
            <button key={String(c)} type="button" onClick={() => setCompany(c)}
              className={`rounded-md px-3 py-1 text-sm ${company === c ? "bg-ink text-white" : "text-muted hover:bg-panel"}`}>
              {c ? "Firma (z NIP)" : "Osoba prywatna"}
            </button>
          ))}
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div><label className="label" htmlFor="name">{company ? "Nazwa firmy" : "Imię i nazwisko"}</label><input id="name" className="input" name="name" defaultValue={draft.buyer.name} required /></div>
          {company && (
            <div>
              <label className="label" htmlFor="nip">NIP</label>
              <div className="flex gap-2">
                <input id="nip" className="input font-mono" name="nip" defaultValue={draft.buyer.nip ?? ""} placeholder="1234567890" required
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void fetchNip(); } }} />
                <button type="button" className="btn-secondary whitespace-nowrap" onClick={fetchNip} disabled={lookup.busy}>{lookup.busy ? "Szukam…" : "Pobierz z GUS"}</button>
              </div>
              {lookup.msg && <p className={`mt-1 text-xs ${lookup.error ? "text-warn" : "text-ok"}`}>{lookup.msg}</p>}
            </div>
          )}
          <div><label className="label" htmlFor="address1">Ulica i numer</label><input id="address1" className="input" name="address1" defaultValue={draft.buyer.address1 ?? ""} /></div>
          <div className="grid grid-cols-[1fr_5rem] gap-2">
            <div><label className="label" htmlFor="address2">Kod pocztowy i miasto</label><input id="address2" className="input" name="address2" defaultValue={draft.buyer.address2 ?? ""} /></div>
            <div><label className="label" htmlFor="country">Kraj</label><input id="country" className="input uppercase" name="country" maxLength={2} defaultValue={draft.buyer.country ?? "PL"} /></div>
          </div>
          <div>
            <label className="label" htmlFor="email">E-mail (faktura pójdzie tu automatycznie)</label>
            <input id="email" className="input" type="email" name="email" defaultValue={draft.buyer.email ?? ""} />
          </div>
          <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" name="save_customer" value="1" defaultChecked /> Zapisz nabywcę na liście</label>
        </div>
      </section>
      )}

      <section className="card overflow-x-auto p-4">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="h2">Pozycje</h2>
          <div className="relative w-full sm:ml-auto sm:w-96">
            <SearchInput value={itemQ} onChange={(e) => setItemQ(e.target.value)} onScan={setItemQ} placeholder="Dodaj z magazynu / katalogu: nazwa, kod S…, IMEI, SKU" aria-label="Szukaj pozycji w magazynie i katalogu" />
            {itemHits.length > 0 && (
              <ul className="absolute right-0 z-30 mt-1 max-h-80 w-full overflow-auto rounded-md border border-line bg-white py-1 text-sm shadow-lg">
                {itemHits.map((h) => (
                  <li key={h.key}>
                    <button type="button" className="flex w-full items-baseline justify-between gap-2 px-3 py-1.5 text-left hover:bg-panel" onClick={() => addItem(h)}>
                      <span><span className="font-medium">{h.name}</span><span className="block text-xs text-muted">{h.detail}</span></span>
                      <span className="whitespace-nowrap tabular-nums">{h.price !== null ? pl(h.price) : "–"}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        {/* Pozycje: na szerokim ekranie w jednym wierszu; węższe (kasa POS, tablet, telefon) – nazwa na całą szerokość,
            pod nią ilość, cena i VAT (wcześniej na średnim ekranie pole nazwy było wąskie i trudno było wpisać nazwę). */}
        <div className="divide-y divide-line">
          <div className="hidden gap-2 pb-2 text-xs font-medium text-muted xl:grid xl:grid-cols-[minmax(0,1fr)_5rem_5rem_8rem_9rem_7rem_2rem]">
            <span>Nazwa</span><span>Ilość</span><span>J.m.</span><span>Cena brutto</span><span>VAT</span><span className="text-right">Wartość</span><span />
          </div>
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-6 items-end gap-2 py-3 sm:grid-cols-12 xl:grid-cols-[minmax(0,1fr)_5rem_5rem_8rem_9rem_7rem_2rem] xl:items-center xl:py-2">
              <label className="col-span-5 sm:col-span-11 xl:col-span-1"><span className="mb-1 block text-xs text-muted xl:hidden">Nazwa</span>
                <input className="input text-base" value={r.name} onChange={(e) => set(i, { name: e.target.value })} aria-label="Nazwa" required autoComplete="off" /></label>
              <button type="button" className="col-span-1 h-10 text-lg text-muted hover:text-bad xl:order-last" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} aria-label="Usuń pozycję" disabled={rows.length === 1}>×</button>
              <label className="col-span-2 xl:col-span-1"><span className="mb-1 block text-xs text-muted xl:hidden">Ilość</span>
                <input className="input" inputMode="decimal" value={r.quantity} onChange={(e) => set(i, { quantity: e.target.value })} aria-label="Ilość" /></label>
              <label className="col-span-2 xl:col-span-1"><span className="mb-1 block text-xs text-muted xl:hidden">J.m.</span>
                <input className="input" value={r.unit} onChange={(e) => set(i, { unit: e.target.value })} aria-label="Jednostka" /></label>
              <label className="col-span-2 sm:col-span-3 xl:col-span-1"><span className="mb-1 block text-xs text-muted xl:hidden">Cena brutto</span>
                <input className="input" inputMode="decimal" value={r.price} onChange={(e) => set(i, { price: e.target.value })} aria-label="Cena brutto" required /></label>
              <label className="col-span-4 sm:col-span-3 xl:col-span-1"><span className="mb-1 block text-xs text-muted xl:hidden">VAT</span>
                <select className={`input ${r.checkVat ? "border-amber-400 bg-amber-50" : ""}`} value={r.vat} onChange={(e) => set(i, { vat: e.target.value as Row["vat"] })} aria-label="Stawka" title={r.checkVat ? "Brak sztuki z magazynu – sprawdź, czy to towar używany (marża)" : undefined}>
                  <option value="margin">VAT marża</option>
                  <option value="23">23%</option>
                </select></label>
              <span className="col-span-2 min-w-0 pb-2.5 text-right text-sm font-medium tabular-nums xl:col-span-1 xl:pb-0"><span className="block text-xs font-normal text-muted xl:hidden">Wartość</span><span className="whitespace-nowrap">{pl(num(r.price) * num(r.quantity))}</span></span>
            </div>
          ))}
        </div>
        <button type="button" className="btn-secondary mt-2 px-3 py-1 text-sm" onClick={() => setRows((rs) => [...rs, { name: "", quantity: "1", unit: "szt.", price: "", vat: "margin" }])}>+ Pozycja</button>
        <div className="mt-4 ml-auto max-w-sm space-y-1 text-sm">
          {totals.g23 > 0 && <><div className="flex justify-between"><span>Netto 23%</span><span className="tabular-nums">{pl(totals.net)}</span></div><div className="flex justify-between"><span>VAT 23%</span><span className="tabular-nums">{pl(totals.vat)}</span></div></>}
          {totals.margin > 0 && <div className="flex justify-between"><span>Procedura marży</span><span className="tabular-nums">{pl(totals.margin)}</span></div>}
          <div className="flex justify-between border-t border-line pt-1 text-base font-semibold"><span>Razem</span><span className="tabular-nums">{pl(totals.total)}</span></div>
        </div>
      </section>

      <section className="card grid gap-3 p-4 md:grid-cols-4">
        <div><label className="label" htmlFor="issue_date">Data wystawienia</label><input id="issue_date" className="input" type="date" name="issue_date" defaultValue={draft.issueDate} required /></div>
        <div><label className="label" htmlFor="sale_date">Data sprzedaży</label><input id="sale_date" className="input" type="date" name="sale_date" defaultValue={draft.saleDate} required /></div>
        <div>
          <label className="label" htmlFor="payment_method">Płatność</label>
          <select id="payment_method" className="input" name="payment_method" defaultValue={draft.paymentMethod}>
            {PAYMENTS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        {!receipt && <div>
          <label className="label">Status płatności</label>
          <div className="flex gap-1">
            {[true, false].map((p) => (
              <button key={String(p)} type="button" onClick={() => setPaid(p)}
                className={`flex-1 rounded-md border px-2 py-2 text-sm ${paid === p ? "border-ink bg-ink text-white" : "border-line hover:bg-panel"}`}>
                {p ? "Zapłacono" : "Do zapłaty"}
              </button>
            ))}
          </div>
        </div>}
        {paid || receipt
          ? <div><label className="label" htmlFor="paid_at">Data zapłaty</label><input id="paid_at" className="input" type="date" name="paid_at" defaultValue={draft.paidAt ?? draft.issueDate} /></div>
          : <div><label className="label" htmlFor="due_date">Termin płatności</label><input id="due_date" className="input" type="date" name="due_date" defaultValue={draft.dueDate ?? draft.issueDate} /></div>}
        <div className="md:col-span-3"><label className="label" htmlFor="notes">Uwagi (na {receipt ? "paragonie" : "fakturze"})</label><input id="notes" className="input" name="notes" defaultValue={draft.notes ?? ""} /></div>
      </section>

      {canShip && (
        <section className={`card p-4 ${ship ? "border-accent/40" : ""}`}>
          <input type="hidden" name="ship" value={ship ? "1" : "0"} />
          <label className="flex cursor-pointer items-start gap-3">
            <input type="checkbox" checked={ship} onChange={(e) => setShip(e.target.checked)} className="mt-1 h-4 w-4 accent-[var(--color-accent)]" />
            <span>
              <span className="block font-semibold">Wysyłka</span>
              <span className="block text-sm text-muted">Paragon z wysyłką: zamówienie trafi do Sprzedaż → Zamówienia (etykieta, status), ale <b>nie wejdzie do JPK</b>. Umowy sztuk z paragonu wrócą do niewykorzystanych.</span>
            </span>
          </label>
          {ship && (
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div><label className="label" htmlFor="ship_store">Sklep</label>
                <select id="ship_store" className="input" name="ship_store" defaultValue={defaultStore ?? stores[0]?.id}>{stores.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
              <div><label className="label" htmlFor="ship_method">Sposób wysyłki</label>
                <select id="ship_method" className="input" name="ship_method" value={shipMethod} onChange={(e) => setShipMethod(e.target.value)}>
                  {["Paczkomat InPost", "Kurier InPost", "Kurier DPD", "Kurier DHL", "Odbiór osobisty"].map((m) => <option key={m}>{m}</option>)}
                </select></div>
              {/paczkomat/i.test(shipMethod) && <div><label className="label" htmlFor="ship_point">Kod paczkomatu</label><input id="ship_point" className="input font-mono uppercase" name="ship_point" placeholder="np. WAW123M" /></div>}
              <div><label className="label" htmlFor="ship_name">Odbiorca</label><input id="ship_name" className="input" name="ship_name" autoComplete="name" /></div>
              <div><label className="label" htmlFor="ship_phone">Telefon</label><input id="ship_phone" className="input" name="ship_phone" inputMode="tel" autoComplete="tel" /></div>
              <div><label className="label" htmlFor="ship_email">E-mail (opcjonalnie)</label><input id="ship_email" className="input" type="email" name="ship_email" autoComplete="email" /></div>
              <div className="sm:col-span-2"><label className="label" htmlFor="ship_street">Ulica i numer</label><input id="ship_street" className="input" name="ship_street" autoComplete="address-line1" /></div>
              <div><label className="label" htmlFor="ship_zip">Kod pocztowy</label><input id="ship_zip" className="input" name="ship_zip" autoComplete="postal-code" placeholder="00-000" /></div>
              <div><label className="label" htmlFor="ship_city">Miasto</label><input id="ship_city" className="input" name="ship_city" autoComplete="address-level2" /></div>
              <div><label className="label" htmlFor="ship_country">Kraj</label><input id="ship_country" className="input uppercase" name="ship_country" defaultValue="PL" maxLength={2} /></div>
              <div className="sm:col-span-2 lg:col-span-3"><label className="label" htmlFor="ship_note">Uwagi do wysyłki</label><input id="ship_note" className="input" name="ship_note" /></div>
            </div>
          )}
        </section>
      )}

      {receipt ? (
        <div className="space-y-3">
          {needsCheck && <label className="flex items-center gap-2 text-sm text-warn"><input type="checkbox" name="vat_checked" value="1" /> Sprawdziłem stawki VAT pozycji na pomarańczowo</label>}
          {(parState?.error || preview.error) && <p className="text-sm text-bad" role="alert">{parState?.error ?? preview.error}</p>}
          {parState?.id && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm" role="status">
              <span className="font-medium text-ok">Paragon {parState.number} wystawiony – otwiera się wydruk.{parState.note}</span>
              <button type="button" className="btn-secondary" onClick={() => printPdf(`/api/faktury/${parState.id}/pdf`)}>Drukuj ponownie</button>
              <Link className="btn-secondary" href={`/sprzedaz/faktury/${parState.id}`}>Otwórz dokument</Link>
              {parState.orderId && <Link className="btn" href={`/sprzedaz/${parState.orderId}`}>Zamówienie do wysyłki</Link>}
              <a className="text-accent hover:underline" href="/sprzedaz/faktury/nowa?typ=paragon">Nowy paragon</a>
            </div>
          )}
          {!parState?.id && (
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={showPreview} disabled={preview.busy || pending}>{preview.busy ? "Przygotowuję…" : "Podgląd dokumentu"}</button>
              <button className="btn" disabled={pending}>{pending ? "Wystawiam…" : "Wydrukuj dokument"}</button>
            </div>
          )}
          {preview.url && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Podgląd paragonu" onClick={() => setPreview({ busy: false, url: null, error: null })}>
              <div className="flex h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between border-b border-line px-4 py-2">
                  <span className="font-medium">Podgląd dokumentu (numer zostanie nadany przy wydruku)</span>
                  <button type="button" className="text-muted hover:text-ink" onClick={() => setPreview({ busy: false, url: null, error: null })} aria-label="Zamknij">✕</button>
                </div>
                <iframe src={preview.url} title="Podgląd paragonu" className="flex-1" />
                <div className="flex justify-end gap-2 border-t border-line px-4 py-2">
                  <button type="button" className="btn-secondary" onClick={() => setPreview({ busy: false, url: null, error: null })}>Popraw</button>
                  <button type="button" className="btn" disabled={pending} onClick={() => { setPreview({ busy: false, url: null, error: null }); formRef.current?.requestSubmit(); }}>Wydrukuj dokument</button>
                </div>
              </div>
            </div>
          )}
        </div>
      ) : (
      <div className="flex flex-wrap items-center gap-4">
        {ksefReady
          ? <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="send_ksef" value="1" defaultChecked /> Wyślij od razu do KSeF</label>
          : <span className="text-sm text-warn">KSeF nie jest skonfigurowany – faktura zostanie tylko zapisana.</span>}
        {needsCheck && <label className="flex items-center gap-2 text-sm text-warn"><input type="checkbox" name="vat_checked" value="1" /> Sprawdziłem stawki VAT pozycji na pomarańczowo</label>}
        {invState?.error && <p className="text-sm text-bad" role="alert">{invState.error}</p>}
        <button className="btn ml-auto" disabled={pending}>{pending ? "Wystawiam…" : "Wystaw fakturę"}</button>
      </div>
      )}
    </form>
  );
}
