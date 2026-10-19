"use client";

import { useState, useTransition } from "react";
import { enqueueReceipt, type JobView } from "@/app/(app)/sprzedaz/receipt-actions";
import { ReceiptJobStatus } from "@/components/ReceiptJobStatus";

/**
 * „Drukuj paragon” do zamówienia: paragon idzie do kolejki drukarki fiskalnej (program „Drukarka Magazyn”)
 * i drukuje się od razu, gdy program działa. Raz na zamówienie.
 */
export function ReceiptButton({ orderId, receiptId, job: initialJob, compact, className }: { orderId: string; receiptId: number | null; job?: JobView | null; printer?: boolean; compact?: boolean; className?: string }) {
  const [job, setJob] = useState<JobView | null>(initialJob && initialJob.status !== "cancelled" ? initialJob : null);
  const [error, setError] = useState<string | null>(null);
  const [queuing, start] = useTransition();
  const btn = `btn-secondary whitespace-nowrap ${className ?? ""} ${compact ? "px-2.5 py-1 text-xs" : ""}`;

  if (job) return <ReceiptJobStatus job={job} compact={compact} onReset={() => setJob(null)} />;
  if (receiptId) return <span className="relative z-10 whitespace-nowrap text-xs text-ok">✓ paragon nr {receiptId}</span>;
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
