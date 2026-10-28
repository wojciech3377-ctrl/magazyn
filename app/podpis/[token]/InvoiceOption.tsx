"use client";

import { useActionState, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { FileButton } from "@/components/FileButton";
import { prepareSellerInvoiceUpload, submitSellerInvoice } from "../actions";

/** Sprzedający-firma: zamiast podpisywać umowę – wgrywa fakturę (pozycje i ceny jak w linku). */
export function InvoiceOption({ token, currency }: { token: string; currency?: string | null }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(submitSellerInvoice.bind(null, token), null);
  const [file, setFile] = useState<{ path: string; name: string; sig: string } | null>(null);
  const [upload, setUpload] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const [payment, setPayment] = useState<"transfer" | "cash" | "">("");

  async function onFile(f: File | undefined) {
    setFile(null);
    if (!f) return;
    setUpload({ busy: true, error: null });
    const prep = await prepareSellerInvoiceUpload(token, f.name, f.size);
    if ("error" in prep) return setUpload({ busy: false, error: prep.error });
    const { error } = await createClient().storage.from("contracts").uploadToSignedUrl(prep.path, prep.token, f, { contentType: f.type });
    if (error) return setUpload({ busy: false, error: `Nie udało się wgrać pliku: ${error.message}` });
    setFile({ path: prep.path, name: f.name, sig: prep.sig });
    setUpload({ busy: false, error: null });
  }

  if (!open) {
    return (
      <div className="card mb-4 flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="text-sm">
          <b>Sprzedajesz jako firma i wystawiasz fakturę?</b>
          <span className="block text-muted">Zamiast podpisywać umowę wgraj swoją fakturę. / Selling as a company? Upload your invoice instead.</span>
        </div>
        <button type="button" className="btn-secondary" onClick={() => setOpen(true)}>Wgraj fakturę / Upload invoice</button>
      </div>
    );
  }
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw" }).format(new Date());
  return (
    <form action={action} className="card mb-4 space-y-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="h2">Faktura zamiast umowy / Invoice</h2>
        <button type="button" className="text-sm text-muted underline" onClick={() => setOpen(false)}>wolę podpisać umowę</button>
      </div>
      <p className="text-sm text-muted">Pozycje i ceny – jak w umowie poniżej. Faktura powinna być wystawiona na naszą firmę na tę kwotę. / Items and prices as listed below.</p>
      <input type="text" name="website" className="hidden" tabIndex={-1} autoComplete="off" />
      <div className="grid gap-2 sm:grid-cols-2">
        <div><label className="label" htmlFor="inv-company">Nazwa firmy / Company</label><input id="inv-company" className="input" name="company" required autoComplete="organization" /></div>
        <div><label className="label" htmlFor="inv-nip">NIP / VAT ID</label><input id="inv-nip" className="input" name="nip" /></div>
        <div><label className="label" htmlFor="inv-no">Numer faktury / Invoice no.</label><input id="inv-no" className="input" name="doc_number" required /></div>
        <div><label className="label" htmlFor="inv-date">Data wystawienia / Date</label><input id="inv-date" className="input" type="date" name="doc_date" defaultValue={today} required /></div>
        <div>
          <label className="label" htmlFor="inv-vat">Rodzaj faktury / Type</label>
          <select id="inv-vat" className="input" name="vat_form" defaultValue="" required>
            <option value="" disabled>wybierz…</option>
            <option value="vat_margin">VAT marża (procedura marży)</option>
            <option value="vat_23">VAT 23%</option>
          </select>
        </div>
        <div><label className="label" htmlFor="inv-email">E-mail</label><input id="inv-email" className="input" type="email" name="email" autoComplete="email" /></div>
      </div>
      <div>
        <div className="label">Forma zapłaty / Payment</div>
        <div className="grid grid-cols-2 gap-2">
          {([["transfer", "Przelew / Bank transfer"], ["cash", "Gotówka / Cash"]] as const).map(([v, t]) => (
            <label key={v} className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${payment === v ? "border-accent bg-sky-50" : "border-line"}`}>
              <input type="radio" name="payment_method" value={v} checked={payment === v} onChange={() => setPayment(v)} required /> {t}
            </label>
          ))}
        </div>
        {currency ? <p className="mt-2 text-sm">Waluta / Currency: <b>{currency}</b></p> : (
          <div className="mt-2"><label className="label" htmlFor="inv-cur">Waluta faktury / Currency</label>
            <select id="inv-cur" className="input" name="currency" defaultValue="" required>
              <option value="" disabled>wybierz…</option><option value="PLN">PLN</option><option value="EUR">EUR</option>
            </select>
          </div>
        )}
        {payment === "transfer" && (
          <div className="mt-2"><label className="label" htmlFor="inv-bank">Numer konta (IBAN) / Bank account</label><input id="inv-bank" className="input" name="bank" required autoComplete="off" maxLength={80} /></div>
        )}
      </div>
      <div>
        <span className="label">Plik faktury / Invoice file</span>
        <FileButton label="Wybierz plik / Choose file" accept="application/pdf,image/jpeg,image/png" onFile={onFile} disabled={upload.busy} hint="PDF, JPG, PNG – do 10 MB / up to 10 MB" />
        {upload.busy && <p className="mt-1 text-xs text-muted">Wgrywam…</p>}
        {file && <p className="mt-1 text-xs text-ok">Wgrano: {file.name}</p>}
        {upload.error && <p className="mt-1 text-xs text-bad">{upload.error}</p>}
        <input type="hidden" name="file_path" value={file?.path ?? ""} />
        <input type="hidden" name="file_sig" value={file?.sig ?? ""} />
        <input type="hidden" name="file_name" value={file?.name ?? ""} />
      </div>
      {state?.error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-bad" role="alert">{state.error}</p>}
      <button className="btn w-full" disabled={pending || upload.busy || !file || !payment}>{pending ? "Wysyłam…" : "Wyślij fakturę / Send invoice"}</button>
    </form>
  );
}
