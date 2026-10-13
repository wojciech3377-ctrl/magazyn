"use client";

import { useRef } from "react";
import { setExclusionVat } from "./actions";

/** Stawka na paragonie dla reguły wykluczenia – zapis od razu po zmianie. */
export function ExclusionVatSelect({ id, vat, letters }: { id: string; vat: "margin" | "23"; letters: { margin: string; vat23: string } }) {
  const form = useRef<HTMLFormElement>(null);
  return (
    <form ref={form} action={setExclusionVat} className="ml-1">
      <input type="hidden" name="id" value={id} />
      <select name="vat" defaultValue={vat} onChange={() => form.current?.requestSubmit()} aria-label="Stawka na paragonie"
        className="rounded border border-line bg-white px-1 py-0.5 text-xs text-muted">
        <option value="margin">marża ({letters.margin})</option>
        <option value="23">23% ({letters.vat23})</option>
      </select>
    </form>
  );
}
