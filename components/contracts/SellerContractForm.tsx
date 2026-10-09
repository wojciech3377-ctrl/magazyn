"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { ContractPreview } from "@/components/ContractPreview";
import { SignaturePad } from "@/components/SignaturePad";
import { purchaseBlocks, type Company, type ContractItem } from "@/lib/contracts/purchase";
import { COUNTRIES, CURRENCIES, type Lang } from "@/lib/contracts/options";
import type { CatalogHit } from "@/app/umowa/actions";

type Action = (state: { error?: string } | null, formData: FormData) => Promise<{ error?: string }>;

const L = {
  pl: {
    intro: "Uzupełnij swoje dane, przeczytaj umowę i podpisz ją w ramce.",
    date: "Data zawarcia umowy",
    country: "Kraj",
    what: "Co sprzedajesz",
    model: "Model, np. Air Jordan 4 White Cement",
    size: "Rozmiar",
    qty: "Szt.",
    price: "Cena",
    addItem: "+ dodaj kolejną rzecz",
    search: "Wyszukaj model, np. Jordan 4 White Cement",
    manual: "Nie ma na liście? Wpisz ręcznie",
    fromList: "wybierz z listy",
    change: "zmień",
    chooseSize: "Wybierz rozmiar",
    removeItem: "usuń ostatnią",
    you: "Twoje dane",
    name: "Imię i nazwisko",
    id: "PESEL albo numer dowodu osobistego",
    street: "Ulica i numer",
    postcode: "Kod pocztowy",
    city: "Miejscowość",
    payment: "Forma zapłaty",
    transfer: "Przelew na konto",
    cash: "Gotówka",
    currency: "Waluta",
    bank: "Numer konta",
    email: "E-mail (wyślemy kopię umowy)",
    phone: "Telefon",
    signature: "Podpis sprzedającego",
    read: "Przeczytaj treść umowy",
    consent: "Oświadczam, że podane dane są prawdziwe, zapoznałem/am się z treścią umowy i ją akceptuję.",
    sign: "Podpisz umowę",
    signing: "Podpisuję…",
    choose: "Wybierz…",
    binding: "",
  },
  en: {
    intro: "Fill in your details, read the agreement and sign it in the box.",
    date: "Date of the agreement",
    country: "Country",
    what: "What are you selling",
    model: "Model, e.g. Air Jordan 4 White Cement",
    size: "Size",
    qty: "Qty",
    price: "Price",
    addItem: "+ add another item",
    search: "Search for a model, e.g. Jordan 4 White Cement",
    manual: "Not on the list? Type it in",
    fromList: "choose from the list",
    change: "change",
    chooseSize: "Choose size",
    removeItem: "remove last",
    you: "Your details",
    name: "First and last name",
    id: "PESEL or ID card / passport number",
    street: "Street and number",
    postcode: "Postal code",
    city: "City",
    payment: "Payment method",
    transfer: "Bank transfer",
    cash: "Cash",
    currency: "Currency",
    bank: "Bank account number",
    email: "E-mail (we will send you a copy)",
    phone: "Phone",
    signature: "Seller's signature",
    read: "Read the agreement",
    consent: "I declare that the details I have provided are true and that I have read and accept the agreement.",
    sign: "Sign the agreement",
    signing: "Signing…",
    choose: "Choose…",
    binding: "English translation for your information. The binding document you sign is the Polish version (PDF).",
  },
} as const;

export function SellerContractForm({
  action, mode, company, number, date, paymentDays, items: fixedItems, buyerSignature, searchCatalog,
}: {
  action: Action;
  mode: "fixed" | "free";
  company: Company;
  number: string;
  date: string;
  paymentDays: number;
  items: ContractItem[];
  buyerSignature?: string | null;
  searchCatalog?: (q: string) => Promise<CatalogHit[]>;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const [lang, setLang] = useState<Lang>("pl");
  const T = L[lang];
  const [f, setF] = useState({ name: "", idNumber: "", street: "", postcode: "", city: "", bank: "", email: "", phone: "" });
  const [country, setCountry] = useState("PL");
  const [contractDate, setContractDate] = useState(date);
  const [payment, setPayment] = useState<"" | "transfer" | "cash">("");
  const [currency, setCurrency] = useState("");
  const [items, setItems] = useState<FreeItem[]>(mode === "free" ? [newItem(!!searchCatalog)] : []);
  const [signature, setSignature] = useState("");
  const [consent, setConsent] = useState(false);

  const previewItems: ContractItem[] = mode === "fixed"
    ? fixedItems
    : items.filter((i) => i.title).map((i) => ({ title: i.title, option: i.option || "–", qty: Math.max(1, Number(i.qty) || 1), price: Number(i.price.replace(",", ".")) || 0 }));

  const blocks = useMemo(() => purchaseBlocks({
    number, date: contractDate || date, company, paymentDays, items: previewItems,
    paymentMethod: payment || null,
    currency: currency || null,
    seller: {
      name: f.name || "…………………",
      idNumber: f.idNumber || "…………………",
      address: [f.street, [f.postcode, f.city].filter(Boolean).join(" ")].filter(Boolean).join(", ") || "…………………",
      bankAccount: f.bank,
      country,
    },
  }, lang), [f, number, date, contractDate, company, paymentDays, previewItems, payment, currency, country, lang]);

  const input = (key: keyof typeof f, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div>
      <label className="label" htmlFor={key}>{label}</label>
      <input className="input" id={key} name={key} value={f[key]} onChange={(e) => setF({ ...f, [key]: e.target.value })} {...props} />
    </div>
  );

  const choice = <V extends string>(value: V, current: string, set: (v: V) => void, label: string, name: string) => (
    <label className={`cursor-pointer rounded-md border px-3 py-2 text-center text-sm ${current === value ? "border-accent bg-accent/5 font-medium" : "border-line"}`}>
      <input type="radio" name={name} value={value} checked={current === value} onChange={() => set(value)} className="sr-only" required />
      {label}
    </label>
  );

  const preview = <ContractPreview blocks={blocks} buyerSignature={buyerSignature} sellerSignature={signature} />;

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="language" value={lang} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">{T.intro}</p>
        <div className="flex gap-1 text-sm" role="group" aria-label="Język / Language">
          {(["pl", "en"] as const).map((l) => (
            <button type="button" key={l} onClick={() => setLang(l)} className={`rounded-md px-3 py-1.5 ${lang === l ? "bg-ink text-white" : "border border-line"}`}>
              {l === "pl" ? "Polski" : "English"}
            </button>
          ))}
        </div>
      </div>
      {T.binding && <p className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900">{T.binding}</p>}

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          {/* pole-pułapka na boty */}
          <input type="text" name="website" className="hidden" tabIndex={-1} autoComplete="off" />
          <section className="card grid grid-cols-2 gap-3 p-4">
            <div>
              <label className="label" htmlFor="contract_date">{T.date}</label>
              <input className="input" id="contract_date" name="contract_date" type="date" value={contractDate} onChange={(e) => setContractDate(e.target.value)} required />
            </div>
            <div>
              <label className="label" htmlFor="country">{T.country}</label>
              <select className="input" id="country" name="country" value={country} onChange={(e) => setCountry(e.target.value)} required>
                {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c[lang]}</option>)}
              </select>
            </div>
          </section>

          {mode === "free" && (
            <section className="card space-y-3 p-4">
              <h2 className="h2">{T.what}</h2>
              <input type="hidden" name="items" value={JSON.stringify(items)} />
              {items.map((it, idx) => (
                <ItemRow key={it.key} item={it} T={T} searchCatalog={searchCatalog}
                  onChange={(patch) => setItems((all) => all.map((x, i) => (i === idx ? { ...x, ...patch } : x)))} />
              ))}
              <div className="flex gap-3 text-sm">
                <button type="button" className="text-accent underline" onClick={() => setItems([...items, newItem(!!searchCatalog)])}>{T.addItem}</button>
                {items.length > 1 && <button type="button" className="text-muted underline" onClick={() => setItems(items.slice(0, -1))}>{T.removeItem}</button>}
              </div>
            </section>
          )}

          <section className="card space-y-3 p-4">
            <h2 className="h2">{T.you}</h2>
            {input("name", T.name, { required: true, autoComplete: "name" })}
            {input("idNumber", T.id, { required: true })}
            {input("street", T.street, { required: true, autoComplete: "street-address" })}
            <div className="grid grid-cols-3 gap-2">
              {input("postcode", T.postcode, { required: true, autoComplete: "postal-code" })}
              <div className="col-span-2">{input("city", T.city, { required: true, autoComplete: "address-level2" })}</div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {input("email", T.email, { type: "email", autoComplete: "email" })}
              {input("phone", T.phone, { type: "tel", autoComplete: "tel" })}
            </div>
          </section>

          <section className="card space-y-3 p-4">
            <div>
              <div className="label">{T.payment}</div>
              <div className="grid grid-cols-2 gap-2">
                {choice("transfer", payment, setPayment, T.transfer, "payment_method")}
                {choice("cash", payment, setPayment, T.cash, "payment_method")}
              </div>
            </div>
            {payment === "transfer" && input("bank", T.bank, { required: true, autoComplete: "off" })}
            <div>
              <div className="label">{T.currency}</div>
              <div className="grid grid-cols-2 gap-2">
                {CURRENCIES.map((c) => <span key={c.code}>{choice(c.code, currency, setCurrency, c.code, "currency")}</span>)}
              </div>
            </div>
          </section>

          <section className="card space-y-3 p-4">
            <details className="rounded-md border border-line p-3 lg:hidden">
              <summary className="cursor-pointer text-sm font-medium">{T.read}</summary>
              <div className="mt-3">{preview}</div>
            </details>
            <SignaturePad label={T.signature} onChange={setSignature} />
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="consent" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 h-4 w-4" />
              <span>{T.consent}</span>
            </label>
            {state?.error && <p className="text-sm text-bad">{state.error}</p>}
            <button className="btn w-full py-3" disabled={pending || !signature || !consent || !payment || !currency}>{pending ? T.signing : T.sign}</button>
          </section>
        </div>
        <section className="card hidden max-h-[85vh] overflow-y-auto p-5 lg:block">{preview}</section>
      </div>
    </form>
  );
}

type FreeItem = {
  key: string;
  title: string;
  option: string;
  qty: string;
  price: string;
  variant_id?: string;
  image?: string | null;
  options?: { id: string; option: string }[];
  mode: "search" | "manual";
};

function newItem(withSearch: boolean): FreeItem {
  return { key: Math.random().toString(36).slice(2), title: "", option: "", qty: "1", price: "", mode: withSearch ? "search" : "manual" };
}

/** Jedna pozycja: model z katalogu (wyszukiwarka + rozmiar) albo wpisany ręcznie. */
function ItemRow({ item, T, onChange, searchCatalog }: {
  item: FreeItem;
  T: (typeof L)[Lang];
  onChange: (patch: Partial<FreeItem>) => void;
  searchCatalog?: (q: string) => Promise<CatalogHit[]>;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<CatalogHit[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!searchCatalog || item.mode !== "search" || item.options || q.trim().length < 2) {
      setHits([]);
      return;
    }
    const t = setTimeout(async () => {
      setBusy(true);
      setHits(await searchCatalog(q));
      setBusy(false);
    }, 300);
    return () => clearTimeout(t);
  }, [q, item.mode, item.options, searchCatalog]);

  const numbers = (
    <>
      <input className="input col-span-1" inputMode="numeric" placeholder={T.qty} value={item.qty} aria-label={T.qty}
        onChange={(e) => onChange({ qty: e.target.value })} />
      <input className="input col-span-3 sm:col-span-1" inputMode="decimal" placeholder={T.price} value={item.price} aria-label={T.price}
        onChange={(e) => onChange({ price: e.target.value })} required />
    </>
  );

  if (item.mode === "search" && !item.options) {
    return (
      <div className="relative space-y-1 rounded-md border border-line p-2">
        <input className="input" placeholder={T.search} value={q} onChange={(e) => setQ(e.target.value)} aria-label={T.search} />
        {busy && <p className="text-xs text-muted">…</p>}
        {hits.length > 0 && (
          <ul className="max-h-64 divide-y divide-line overflow-y-auto rounded-md border border-line bg-white">
            {hits.map((h) => (
              <li key={h.productId}>
                <button type="button" className="flex w-full items-center gap-3 px-2 py-1.5 text-left text-sm hover:bg-panel"
                  onClick={() => onChange({ title: h.title, image: h.image, options: h.variants, option: "", variant_id: undefined })}>
                  {h.image
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img src={`${h.image}${h.image.includes("?") ? "&" : "?"}width=80`} alt="" className="h-9 w-9 rounded border border-line object-contain" />
                    : <span className="h-9 w-9 rounded border border-line bg-panel" />}
                  <span>{h.title}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <button type="button" className="text-xs text-muted underline" onClick={() => onChange({ mode: "manual" })}>{T.manual}</button>
      </div>
    );
  }

  if (item.mode === "search" && item.options) {
    return (
      <div className="space-y-2 rounded-md border border-line p-2">
        <div className="flex items-center gap-3 text-sm">
          {item.image
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={`${item.image}${item.image.includes("?") ? "&" : "?"}width=80`} alt="" className="h-10 w-10 rounded border border-line object-contain" />
            : null}
          <span className="flex-1 font-medium">{item.title}</span>
          <button type="button" className="text-xs text-muted underline" onClick={() => onChange({ options: undefined, variant_id: undefined, title: "", option: "" })}>{T.change}</button>
        </div>
        <div className="grid grid-cols-6 gap-2">
          <select className="input col-span-2" value={item.variant_id ?? ""} aria-label={T.size} required
            onChange={(e) => onChange({ variant_id: e.target.value, option: item.options!.find((o) => o.id === e.target.value)?.option ?? "" })}>
            <option value="">{T.chooseSize}</option>
            {item.options.map((o) => <option key={o.id} value={o.id}>{o.option}</option>)}
          </select>
          {numbers}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="grid grid-cols-6 gap-2">
        <input className="input col-span-6 sm:col-span-3" placeholder={T.model} value={item.title} aria-label={T.model}
          onChange={(e) => onChange({ title: e.target.value })} required />
        <input className="input col-span-2 sm:col-span-1" placeholder={T.size} value={item.option} aria-label={T.size}
          onChange={(e) => onChange({ option: e.target.value })} required />
        {numbers}
      </div>
      {searchCatalog && <button type="button" className="text-xs text-muted underline" onClick={() => onChange({ mode: "search", title: "", option: "" })}>{T.fromList}</button>}
    </div>
  );
}
