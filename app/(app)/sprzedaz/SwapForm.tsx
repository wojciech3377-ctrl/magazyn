"use client";

import { useActionState } from "react";
import { swapUnit } from "./actions";

export function SwapForm({ saleId }: { saleId: string }) {
  const [state, action, pending] = useActionState(swapUnit, null);
  return (
    <form action={action} className="flex items-center gap-1.5">
      <input type="hidden" name="sale_id" value={saleId} />
      <input className="input w-36 py-1 font-mono text-xs" name="code" placeholder="skan: S000123 / IMEI" aria-label="Kod sztuki do zamiany" />
      <button className="btn-secondary px-2 py-1 text-xs" disabled={pending}>{pending ? "…" : "Zmień"}</button>
      {state?.error && <span className="text-xs text-bad">{state.error}</span>}
      {state?.ok && <span className="text-xs text-ok">{state.ok}</span>}
    </form>
  );
}
