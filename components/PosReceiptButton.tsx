"use client";

import { useState, useTransition } from "react";
import { enqueueReceipt, type JobView } from "@/app/(app)/sprzedaz/receipt-actions";
import { ReceiptJobStatus } from "@/components/ReceiptJobStatus";

/** Paragon do sprzedaży w Kasie: stan wydruku albo „Wystaw paragon”, gdy go jeszcze nie ma. */
export function PosReceiptButton({ posOrderId, job: initial }: { posOrderId: string; job: JobView | null }) {
  const [job, setJob] = useState<JobView | null>(initial && initial.status !== "cancelled" ? initial : null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (job) return <ReceiptJobStatus job={job} onReset={() => setJob(null)} />;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" className="btn" disabled={pending} onClick={() => start(async () => {
        const r = await enqueueReceipt("pos", posOrderId);
        if (r.job) setJob(r.job);
        setError(r.error ?? null);
      })}>{pending ? "Wysyłam…" : "Wystaw paragon"}</button>
      {error && <span className="text-sm text-bad">{error}</span>}
    </span>
  );
}
