"use client";

import { useState } from "react";
import { SubmitButton } from "@/components/SubmitButton";
import { saveOrderNote } from "./actions";

/** Notatka pracowników: czerwony pasek na górze zamówienia (każdy ją widzi) + dodawanie / edycja / usunięcie. */
export function OrderNote({ orderId, note, by, at }: { orderId: string; note: string | null; by: string | null; at: string | null }) {
  const [edit, setEdit] = useState(false);
  const when = at ? new Intl.DateTimeFormat("pl-PL", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Warsaw" }).format(new Date(at)) : null;

  if (edit) {
    return (
      <form action={saveOrderNote} className="mb-4 space-y-2 rounded-lg border-2 border-red-300 bg-red-50 p-3">
        <input type="hidden" name="order_id" value={orderId} />
        <label className="text-sm font-semibold text-red-800" htmlFor="staff_note">Notatka do zamówienia (widzą ją wszyscy, na czerwono na górze)</label>
        <textarea id="staff_note" name="staff_note" defaultValue={note ?? ""} rows={3} maxLength={2000} autoFocus
          className="input min-h-20 w-full border-red-300 bg-white py-2" placeholder="np. Klient prosi o wysyłkę dopiero w piątek" />
        <div className="flex flex-wrap gap-2">
          <SubmitButton className="btn bg-red-600 hover:bg-red-700" pendingText="Zapisuję…">Zapisz notatkę</SubmitButton>
          {note && <SubmitButton className="btn-secondary" name="delete" value="1" pendingText="Usuwam…">Usuń notatkę</SubmitButton>}
          <button type="button" className="btn-secondary" onClick={() => setEdit(false)}>Anuluj</button>
        </div>
      </form>
    );
  }
  if (!note) {
    return (
      <div className="mb-4">
        <button type="button" className="text-sm font-medium text-red-700 hover:underline" onClick={() => setEdit(true)}>+ Dodaj notatkę do zamówienia</button>
      </div>
    );
  }
  return (
    <div className="mb-4 flex flex-wrap items-start gap-3 rounded-lg border-2 border-red-400 bg-red-50 p-3 text-red-900" role="alert">
      <span className="mt-0.5 shrink-0 rounded bg-red-600 px-1.5 py-0.5 text-xs font-bold uppercase tracking-wide text-white">Notatka</span>
      <p className="min-w-0 flex-1 whitespace-pre-wrap text-base font-semibold">{note}</p>
      <div className="flex shrink-0 items-center gap-3 text-xs text-red-700">
        {(by || when) && <span>{[by, when].filter(Boolean).join(" · ")}</span>}
        <button type="button" className="font-medium underline" onClick={() => setEdit(true)}>edytuj</button>
      </div>
    </div>
  );
}
