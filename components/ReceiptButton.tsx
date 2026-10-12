"use client";

import { useActionState, useState, useTransition } from "react";
import { issueReceipt, type ReceiptState } from "@/app/(app)/sprzedaz/[id]/actions";
import { enqueueReceipt, type JobView } from "@/app/(app)/sprzedaz/receipt-actions";
import { ReceiptJobStatus } from "@/components/ReceiptJobStatus";

/**
 * „Drukuj paragon” do zamówienia. Z podłączoną drukarką fiskalną (Ustawienia → Drukarka fiskalna) paragon idzie do
 * naszej kolejki i drukuje się od razu; bez niej – jak dotąd przez Base. Raz na zamówienie.
 */
export function ReceiptButton({ orderId, receiptId, job: initialJob, printer, compact }: { orderId: string; receiptId: number | null; job?: JobView | null; printer?: boolean; compact?: boolean }) {
  const [state, action, pending] = useActionState<ReceiptState, FormData>(issueReceipt, null);
  const [job, setJob] = useState<JobView | null>(initialJob && initialJob.status !== "cancelled" ? initialJob : null);
  const [error, setError] = useState<string | null>(null);
  const [queuing, start] = useTransition();
  const btn = `btn-secondary whitespace-nowrap ${compact ? "px-2.5 py-1 text-xs" : ""}`;

  if (job) return <ReceiptJobStatus job={job} compact={compact} onReset={() => setJob(null)} />;
  if (receiptId || state?.ok) {
    return <span className="relative z-10 whitespace-nowrap text-xs text-ok" title={state?.ok}>✓ paragon{receiptId ? ` nr ${receiptId}` : ""}</span>;
  }
  if (printer) {
    return (
      <span className="relative z-10 inline-flex flex-col items-start gap-1">
        <button type="button" className={btn} disabled={queuing} onClick={() => {
          if (!confirm("Wystawić paragon fiskalny do tego zamówienia? Drukarka wydrukuje go od razu.")) return;
          start(async () => {
            const r = await enqueueReceipt("order", orderId);
            if (r.job) setJob(r.job);
            setError(r.error ?? null);
          });
        }}>{queuing ? "Wysyłam…" : "Drukuj paragon"}</button>
        {error && <span className="max-w-56 text-xs text-bad">{error}</span>}
      </span>
    );
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
      <button className={btn} disabled={pending}>{pending ? "Wysyłam…" : "Drukuj paragon"}</button>
      {state?.error && <span className="max-w-56 text-xs text-bad">{state.error}</span>}
    </form>
  );
}
