"use client";

import { useActionState } from "react";
import { issueReceipt, type ReceiptState } from "@/app/(app)/sprzedaz/[id]/actions";

/** „Drukuj paragon” – paragon w Base, wydruk na drukarce fiskalnej. Raz na zamówienie. */
export function ReceiptButton({ orderId, receiptId, compact }: { orderId: string; receiptId: number | null; compact?: boolean }) {
  const [state, action, pending] = useActionState<ReceiptState, FormData>(issueReceipt, null);
  if (receiptId || state?.ok) {
    return <span className="relative z-10 whitespace-nowrap text-xs text-ok" title={state?.ok}>✓ paragon{receiptId ? ` nr ${receiptId}` : ""}</span>;
  }
  return (
    <form
      action={action}
      className="relative z-10 inline-flex flex-col items-start gap-1"
      onSubmit={(e) => {
        if (!confirm("Wystawić paragon fiskalny do tego zamówienia? Drukarka wydrukuje go od razu.")) e.preventDefault();
      }}
    >
      <input type="hidden" name="order_id" value={orderId} />
      <button className={`btn-secondary whitespace-nowrap ${compact ? "px-2.5 py-1 text-xs" : ""}`} disabled={pending}>{pending ? "Wysyłam…" : "Drukuj paragon"}</button>
      {state?.error && <span className="max-w-56 text-xs text-bad">{state.error}</span>}
    </form>
  );
}
