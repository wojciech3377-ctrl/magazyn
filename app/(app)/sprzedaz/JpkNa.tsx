"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setJpkNa } from "./actions";

/** „Nie dotyczy” przy pozycji JPK bez umowy – mały przycisk; oznaczona pozycja zostaje w JPK i w Excelu. */
export function JpkNa({ lineKey, on }: { lineKey: string; on: boolean }) {
  const router = useRouter();
  const [state, setState] = useState(on);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const toggle = (next: boolean) => start(async () => {
    const r = await setJpkNa(lineKey, next);
    if (r.error) { setError(r.error); return; }
    setError(null);
    setState(next);
    router.refresh();
  });
  if (state) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="rounded border border-slate-300 bg-slate-50 px-1.5 py-0.5 text-xs text-slate-600">nie dotyczy</span>
        <button type="button" className="text-[11px] text-muted hover:text-ink hover:underline" disabled={pending} onClick={() => toggle(false)}>{pending ? "…" : "cofnij"}</button>
        {error && <span className="text-[11px] text-bad">{error}</span>}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      <button type="button" className="rounded border border-line px-1.5 py-0.5 text-[11px] text-muted hover:border-slate-400 hover:text-ink" disabled={pending}
        title="Ta pozycja nie potrzebuje umowy (np. sznurówki, własny towar) – zostaje w JPK i w Excelu" onClick={() => toggle(true)}>{pending ? "…" : "nie dotyczy"}</button>
      {error && <span className="text-[11px] text-bad">{error}</span>}
    </span>
  );
}
