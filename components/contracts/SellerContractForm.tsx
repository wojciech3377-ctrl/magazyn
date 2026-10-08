"use client";

import { useActionState, useMemo, useState } from "react";
import { ContractPreview } from "@/components/ContractPreview";
import { SignaturePad } from "@/components/SignaturePad";
import { purchaseBlocks, type Company, type ContractItem } from "@/lib/contracts/purchase";

type Action = (state: { error?: string } | null, formData: FormData) => Promise<{ error?: string }>;

export function SellerContractForm({
  action, mode, company, number, date, paymentDays, items: fixedItems,
}: {
  action: Action;
  mode: "fixed" | "free";
  company: Company;
  number: string;
  date: string;
  paymentDays: number;
  items: ContractItem[];
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const [f, setF] = useState({ name: "", idNumber: "", street: "", postcode: "", city: "", bank: "", email: "", phone: "" });
  const [items, setItems] = useState<{ title: string; option: string; qty: string; price: string }[]>(
    mode === "free" ? [{ title: "", option: "", qty: "1", price: "" }] : [],
  );
  const [signature, setSignature] = useState("");
  const [consent, setConsent] = useState(false);

  const previewItems: ContractItem[] = mode === "fixed"
    ? fixedItems
    : items.filter((i) => i.title).map((i) => ({ title: i.title, option: i.option || "–", qty: Math.max(1, Number(i.qty) || 1), price: Number(i.price.replace(",", ".")) || 0 }));

  const blocks = useMemo(() => purchaseBlocks({
    number, date, company, paymentDays, items: previewItems,
    seller: {
      name: f.name || "…………………",
      idNumber: f.idNumber || "…………………",
      address: [f.street, [f.postcode, f.city].filter(Boolean).join(" ")].filter(Boolean).join(", ") || "…………………",
      bankAccount: f.bank || "…………………",
    },
  }), [f, number, date, company, paymentDays, previewItems]);

  const input = (key: keyof typeof f, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div>
      <label className="label" htmlFor={key}>{label}</label>
      <input className="input" id={key} name={key} value={f[key]} onChange={(e) => setF({ ...f, [key]: e.target.value })} {...props} />
    </div>
  );

  return (
    <form action={formAction} className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-4">
        {/* pole-pułapka na boty */}
        <input type="text" name="website" className="hidden" tabIndex={-1} autoComplete="off" />
        {mode === "free" && (
          <section className="card space-y-3 p-4">
            <h2 className="h2">Co sprzedajesz</h2>
            <input type="hidden" name="items" value={JSON.stringify(items)} />
            {items.map((it, idx) => (
              <div key={idx} className="grid grid-cols-6 gap-2">
                <input className="input col-span-6 sm:col-span-3" placeholder="Model, np. Air Jordan 4 White Cement" value={it.title} aria-label="Model"
                  onChange={(e) => setItems(items.map((x, i) => (i === idx ? { ...x, title: e.target.value } : x)))} required />
                <input className="input col-span-2 sm:col-span-1" placeholder="Rozmiar" value={it.option} aria-label="Rozmiar"
                  onChange={(e) => setItems(items.map((x, i) => (i === idx ? { ...x, option: e.target.value } : x)))} required />
                <input className="input col-span-1" inputMode="numeric" placeholder="Szt." value={it.qty} aria-label="Ilość"
                  onChange={(e) => setItems(items.map((x, i) => (i === idx ? { ...x, qty: e.target.value } : x)))} />
                <input className="input col-span-3 sm:col-span-1" inputMode="decimal" placeholder="Cena zł" value={it.price} aria-label="Cena"
                  onChange={(e) => setItems(items.map((x, i) => (i === idx ? { ...x, price: e.target.value } : x)))} required />
              </div>
            ))}
            <div className="flex gap-3 text-sm">
              <button type="button" className="text-accent underline" onClick={() => setItems([...items, { title: "", option: "", qty: "1", price: "" }])}>+ dodaj kolejną rzecz</button>
              {items.length > 1 && <button type="button" className="text-muted underline" onClick={() => setItems(items.slice(0, -1))}>usuń ostatnią</button>}
            </div>
          </section>
        )}
        <section className="card space-y-3 p-4">
          <h2 className="h2">Twoje dane</h2>
          {input("name", "Imię i nazwisko", { required: true, autoComplete: "name" })}
          {input("idNumber", "PESEL albo numer dowodu osobistego", { required: true })}
          {input("street", "Ulica i numer", { required: true, autoComplete: "street-address" })}
          <div className="grid grid-cols-3 gap-2">
            {input("postcode", "Kod pocztowy", { required: true, autoComplete: "postal-code" })}
            <div className="col-span-2">{input("city", "Miejscowość", { required: true, autoComplete: "address-level2" })}</div>
          </div>
          {input("bank", "Numer konta do przelewu", { required: true, inputMode: "numeric" })}
          <div className="grid grid-cols-2 gap-2">
            {input("email", "E-mail (wyślemy kopię umowy)", { type: "email", autoComplete: "email" })}
            {input("phone", "Telefon", { type: "tel", autoComplete: "tel" })}
          </div>
        </section>
        <section className="card space-y-3 p-4">
          <details className="rounded-md border border-line p-3 lg:hidden">
            <summary className="cursor-pointer text-sm font-medium">Przeczytaj treść umowy</summary>
            <div className="mt-3"><ContractPreview blocks={blocks} /></div>
          </details>
          <SignaturePad label="Podpis sprzedającego" onChange={setSignature} />
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="consent" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 h-4 w-4" />
            <span>Oświadczam, że podane dane są prawdziwe, zapoznałem/am się z treścią umowy i ją akceptuję.</span>
          </label>
          {state?.error && <p className="text-sm text-bad">{state.error}</p>}
          <button className="btn w-full py-3" disabled={pending || !signature || !consent}>{pending ? "Podpisuję…" : "Podpisz umowę"}</button>
        </section>
      </div>
      <section className="card hidden max-h-[80vh] overflow-y-auto p-5 lg:block">
        <ContractPreview blocks={blocks} />
      </section>
    </form>
  );
}
