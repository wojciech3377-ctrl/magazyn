"use client";

import { useActionState, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { prepareLabelUpload, requestShipment, type ShipState } from "./actions";
import type { ShipAddress } from "@/lib/consignment";

type U = { id: string; code: string; title: string; option: string; status: string; price: number | null; received: string };
const pln = (n: number | null) => (n === null ? "–" : new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN" }).format(n));

/** Lista rzeczy na stanie z zaznaczaniem i zleceniem wysyłki do komisanta. */
export function ShipRequestForm({ units, address, fee }: { units: U[]; address: ShipAddress | null; fee: number }) {
  const [state, action, pending] = useActionState<ShipState, FormData>(requestShipment, null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [method, setMethod] = useState<"default" | "custom" | "own_label">(address ? "default" : "custom");
  const [label, setLabel] = useState<{ path: string; name: string } | null>(null);
  const [upload, setUpload] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const selectable = units.filter((u) => u.status === "in_stock");

  async function onFile(file: File | undefined) {
    setLabel(null);
    if (!file) return;
    setUpload({ busy: true, error: null });
    const prep = await prepareLabelUpload(file.name, file.size);
    if ("error" in prep) return setUpload({ busy: false, error: prep.error });
    const { error } = await createClient().storage.from("consignor-labels").uploadToSignedUrl(prep.path, prep.token, file, { contentType: file.type });
    if (error) return setUpload({ busy: false, error: `Nie udało się wgrać pliku: ${error.message}` });
    setLabel({ path: prep.path, name: file.name });
    setUpload({ busy: false, error: null });
  }

  return (
    <form action={action} className="space-y-4">
      <div className="card overflow-x-auto">
        <table className="table">
          <thead><tr><th className="w-8" /><th>Rzecz</th><th>Kod</th><th>Status</th><th>Przyjęta</th><th className="text-right">Twoja kwota</th></tr></thead>
          <tbody>
            {!units.length && <tr><td colSpan={6} className="py-6 text-center text-muted">Nie masz teraz rzeczy na stanie.</td></tr>}
            {units.map((u) => (
              <tr key={u.id}>
                <td>{u.status === "in_stock" && <input type="checkbox" name="unit" value={u.id} className="h-4 w-4" checked={picked.has(u.id)}
                  onChange={(e) => { const n = new Set(picked); if (e.target.checked) n.add(u.id); else n.delete(u.id); setPicked(n); }} aria-label={`Wybierz ${u.title}`} />}</td>
                <td>{u.title} · <b>{u.option}</b></td>
                <td className="font-mono text-xs">{u.code}</td>
                <td className="text-sm">{u.status === "in_stock" ? "na stanie" : u.status === "consignor_hold" ? "odłożona do wysyłki do Ciebie" : u.status === "reserved" ? "zarezerwowana" : "w drodze do nas"}</td>
                <td className="text-sm text-muted">{u.received}</td>
                <td className="text-right tabular-nums">{pln(u.price)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selectable.length > 0 && (
        <div className="card space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="font-medium">Zleć wysyłkę do siebie</h3>
            <button type="button" className="text-sm text-accent hover:underline" onClick={() => setPicked(new Set(selectable.map((u) => u.id)))}>zaznacz wszystkie</button>
            <span className="text-sm text-muted">zaznaczono: {picked.size}</span>
          </div>
          <fieldset className="space-y-2 text-sm">
            <label className={`flex items-start gap-2 ${address ? "" : "opacity-50"}`}>
              <input type="radio" name="method" value="default" checked={method === "default"} disabled={!address} onChange={() => setMethod("default")} className="mt-1" />
              <span>Na mój adres z konta{address ? <span className="block text-muted">{address.name}, {address.street}, {address.postcode} {address.city}</span> : <span className="block text-muted">brak adresu w koncie – napisz do nas albo wybierz inny adres</span>}</span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" name="method" value="custom" checked={method === "custom"} onChange={() => setMethod("custom")} className="mt-1" />
              <span>Na inny adres <span className="text-muted">– płatna wysyłka {pln(fee)}, wystawimy fakturę</span></span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" name="method" value="own_label" checked={method === "own_label"} onChange={() => setMethod("own_label")} className="mt-1" />
              <span>Mam własną etykietę wysyłkową <span className="text-muted">(PDF, JPG albo PNG)</span></span>
            </label>
          </fieldset>
          {method === "custom" && (
            <div className="grid gap-2 sm:grid-cols-3">
              <input className="input" name="name" placeholder="Imię i nazwisko / firma" required />
              <input className="input" name="street" placeholder="Ulica i numer" required />
              <input className="input" name="phone" placeholder="Telefon" required />
              <input className="input" name="postcode" placeholder="Kod pocztowy" required />
              <input className="input" name="city" placeholder="Miasto" required />
              <input className="input uppercase" name="country" placeholder="Kraj (PL)" maxLength={2} defaultValue="PL" />
            </div>
          )}
          {method === "own_label" && (
            <div className="space-y-1 text-sm">
              <input type="file" accept="application/pdf,image/jpeg,image/png" onChange={(e) => onFile(e.target.files?.[0])} aria-label="Plik etykiety" />
              {label && <input type="hidden" name="label_path" value={label.path} />}
              {label && <input type="hidden" name="label_name" value={label.name} />}
              {upload.busy && <p className="text-muted">Wgrywam…</p>}
              {label && <p className="text-ok">Etykieta wgrana: {label.name}</p>}
              {upload.error && <p className="text-bad">{upload.error}</p>}
            </div>
          )}
          <input className="input" name="note" placeholder="Uwagi (opcjonalnie)" maxLength={500} />
          {state?.error && <p className="text-sm text-bad" role="alert">{state.error}</p>}
          {state?.ok && <p className="text-sm font-medium text-ok" role="status">{state.ok}</p>}
          <button className="btn" disabled={pending || !picked.size || (method === "own_label" && !label) || upload.busy}>
            {pending ? "Wysyłam zlecenie…" : `Zleć wysyłkę (${picked.size} szt.)`}
          </button>
        </div>
      )}
    </form>
  );
}
