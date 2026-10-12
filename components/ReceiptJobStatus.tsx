"use client";

import { useEffect, useState, useTransition } from "react";
import { cancelReceiptJob, retryReceiptJob, receiptJobStatus, type JobView } from "@/app/(app)/sprzedaz/receipt-actions";
import { Pill } from "@/components/ui";

const TEXT: Record<string, { text: string; tone: "slate" | "amber" | "green" | "red" | "blue" }> = {
  queued: { text: "paragon w kolejce do drukarki", tone: "blue" },
  printing: { text: "paragon drukuje się…", tone: "amber" },
  printed: { text: "paragon wydrukowany", tone: "green" },
  error: { text: "błąd wydruku paragonu", tone: "red" },
  cancelled: { text: "paragon anulowany", tone: "slate" },
};

/** Stan paragonu fiskalnego – odświeża się sam, dopóki drukarka nie skończy; przy błędzie „Ponów”. */
export function ReceiptJobStatus({ job: initial, compact, onReset }: { job: JobView; compact?: boolean; onReset?: () => void }) {
  const [job, setJob] = useState(initial);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const waiting = job.status === "queued" || job.status === "printing";
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(async () => {
      const j = await receiptJobStatus(job.id);
      if (j) setJob(j);
    }, 2500);
    return () => clearInterval(t);
  }, [job.id, waiting]);
  const stuck = job.status === "printing" && job.claimed_at && Date.now() - new Date(job.claimed_at).getTime() > 120_000;
  const st = TEXT[job.status] ?? TEXT.queued;
  const act = (fn: (id: string) => Promise<{ job?: JobView; error?: string }>, confirmText?: string) => () => {
    if (confirmText && !confirm(confirmText)) return;
    start(async () => {
      const r = await fn(job.id);
      if (r.job) setJob(r.job);
      setMsg(r.error ?? null);
      if (r.job?.status === "cancelled") onReset?.();
    });
  };
  return (
    <span className={`relative z-10 inline-flex flex-wrap items-center gap-1.5 ${compact ? "text-xs" : "text-sm"}`}>
      <Pill tone={st.tone}>{st.text}{job.receipt_number ? ` nr ${job.receipt_number}` : ""}</Pill>
      {job.status === "error" && job.error && <span className="max-w-64 text-xs text-bad">{job.error}</span>}
      {(job.status === "error" || stuck) && (
        <button type="button" className="text-xs font-medium text-accent hover:underline" disabled={pending}
          onClick={act(retryReceiptJob, stuck ? "Program drukarki nie odpowiada od 2 minut. Sprawdź na drukarce, czy paragon nie wyszedł – ponowić wydruk?" : undefined)}>Ponów</button>
      )}
      {(job.status === "error" || job.status === "queued") && (
        <button type="button" className="text-xs text-muted hover:text-bad hover:underline" disabled={pending} onClick={act(cancelReceiptJob, "Anulować ten paragon?")}>anuluj</button>
      )}
      {msg && <span className="text-xs text-bad">{msg}</span>}
    </span>
  );
}
