"use client";

import { useActionState, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { attachConsignorInvoice, createConsignorContract, prepareInvoiceUpload, type DocState } from "./actions";

export type SoldRow = {
  id: string; code: string; title: string; option: string; price: number | null; soldAt: string; hasDocument: boolean;
  doc: { kind: "none" } | { kind: "sign"; href: string | null } | { kind: "approve" } | { kind: "done"; label: string };
};

const pln = (n: number | null) => (n === null ? "–" : new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN" }).format(n));
const today = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw" }).format(new Date());

/** Sprzedane rzeczy komisanta: umowa / faktura do każdej rzeczy i rozliczenie. */
export function SoldList({ rows }: { rows: SoldRow[] }) {
  const [contractState, contractAction, contractPending] = useActionState<DocState, FormData>(createConsignorContract, null);
  const [invoiceState, invoiceAction, invoicePending] = useActionState<DocState, FormData>(attachConsignorInvoice, null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<"contract" | "invoice" | null>(null);
  const [file, setFile] = useState<{ path: string; name: string } | null>(null);
  const [upload, setUpload] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const open = rows.filter((r) => r.doc.kind === "none");
  const pending = contractPending || invoicePending;
  const state = mode === "invoice" ? invoiceState : contractState;

  async function onFile(f: File | undefined) {
    setFile(null);
    if (!f) return;
    setUpload({ busy: true, error: null });
    const prep = await prepareInvoiceUpload(f.name, f.size);
    if ("error" in prep) return setUpload({ busy: false, error: prep.error });
    const { error } = await createClient().storage.from("contracts").uploadToSignedUrl(prep.path, prep.token, f, { contentType: f.type });
    if (error) return setUpload({ busy: false, error: `Nie udało się wgrać pliku: ${error.message}` });
    setFile({ path: prep.path, name: f.name });
    setUpload({ busy: false, error: null });
  }

  const toggle = (id: string, on: boolean) => { const n = new Set(picked); if (on) n.add(id); else n.delete(id); setPicked(n); };

  return (
    <form className="space-y-4">
      {open.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
          <b>{open.length === 1 ? "1 sprzedana rzecz czeka" : `${open.length} sprzedanych rzeczy czeka`} na umowę albo fakturę.</b> Zaznacz je i wybierz „Dołącz umowę” – wypełnisz i podpiszesz umowę online albo wgrasz swoją fakturę.
        </div>
      )}
      <div className="card overflow-x-auto">
        <table className="table">
          <thead><tr><th className="w-8" /><th>Rzecz</th><th>Data sprzedaży</th><th className="text-right">Twoja kwota</th><th>Umowa / faktura</th><th>Rozliczenie</th></tr></thead>
          <tbody>
            {!rows.length && <tr><td colSpan={6} className="py-6 text-center text-muted">Jeszcze nic nie sprzedaliśmy.</td></tr>}
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.doc.kind === "none" && <input type="checkbox" name="sold" value={r.id} className="h-4 w-4" checked={picked.has(r.id)} onChange={(e) => toggle(r.id, e.target.checked)} aria-label={`Wybierz ${r.title}`} />}</td>
                <td>{r.title} · <b>{r.option}</b> <span className="font-mono text-xs text-muted">{r.code}</span></td>
                <td className="whitespace-nowrap text-sm text-muted">{r.soldAt}</td>
                <td className="text-right tabular-nums">{pln(r.price)}</td>
                <td className="text-sm">
                  {r.doc.kind === "none" && <span className="font-medium text-warn">brak – dołącz umowę</span>}
                  {r.doc.kind === "sign" && (r.doc.href ? <a className="font-medium text-accent hover:underline" href={r.doc.href}>dokończ i podpisz umowę</a> : <span className="text-muted">umowa do podpisu</span>)}
                  {r.doc.kind === "approve" && <span className="text-muted">przesłane – sprawdzamy</span>}
                  {r.doc.kind === "done" && <span className="text-ok">{r.doc.label} ✓</span>}
                </td>
                <td>{r.hasDocument ? <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-800">do wypłaty</span> : <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">czeka na paragon / fakturę sprzedaży</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {open.length > 0 && (
        <div className="card space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="font-medium">Dołącz umowę</h3>
            <button type="button" className="text-sm text-accent hover:underline" onClick={() => setPicked(new Set(open.map((r) => r.id)))}>zaznacz wszystkie bez umowy</button>
            <span className="text-sm text-muted">zaznaczono: {picked.size}</span>
          </div>
          <fieldset className="space-y-2 text-sm">
            <label className="flex items-start gap-2">
              <input type="radio" name="doc_mode" checked={mode === "contract"} onChange={() => setMode("contract")} className="mt-1" />
              <span>Wypełnię umowę kupna online <span className="block text-muted">Wpiszesz swoje dane i podpiszesz umowę na ekranie. Pozycje i kwoty są już uzupełnione.</span></span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" name="doc_mode" checked={mode === "invoice"} onChange={() => setMode("invoice")} className="mt-1" />
              <span>Mam fakturę <span className="block text-muted">Wgraj fakturę wystawioną na nas (PDF, JPG albo PNG).</span></span>
            </label>
          </fieldset>
          {mode === "invoice" && (
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="sm:col-span-3 space-y-1 text-sm">
                <input type="file" accept="application/pdf,image/jpeg,image/png" onChange={(e) => onFile(e.target.files?.[0])} aria-label="Plik faktury" />
                {file && <input type="hidden" name="file_path" value={file.path} />}
                {file && <input type="hidden" name="file_name" value={file.name} />}
                {upload.busy && <p className="text-muted">Wgrywam…</p>}
                {file && <p className="text-ok">Plik wgrany: {file.name}</p>}
                {upload.error && <p className="text-bad">{upload.error}</p>}
              </div>
              <input className="input" name="doc_number" placeholder="Numer faktury" maxLength={60} aria-label="Numer faktury" />
              <input className="input" type="date" name="doc_date" defaultValue={today()} aria-label="Data wystawienia" />
            </div>
          )}
          {state?.error && <p className="text-sm text-bad" role="alert">{state.error}</p>}
          {state?.ok && <p className="text-sm font-medium text-ok" role="status">{state.ok}</p>}
          {mode === "contract" && (
            <button className="btn" formAction={contractAction} disabled={pending || !picked.size}>
              {contractPending ? "Przygotowuję umowę…" : `Wypełnij umowę (${picked.size} szt.)`}
            </button>
          )}
          {mode === "invoice" && (
            <button className="btn" formAction={invoiceAction} disabled={pending || !picked.size || !file || upload.busy}>
              {invoicePending ? "Zapisuję…" : `Dołącz fakturę (${picked.size} szt.)`}
            </button>
          )}
        </div>
      )}
      {open.length === 0 && invoiceState?.ok && <p className="text-sm font-medium text-ok" role="status">{invoiceState.ok}</p>}
    </form>
  );
}
