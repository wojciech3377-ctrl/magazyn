"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { enqueuePartialReceipt, type JobView } from "../receipt-actions";
import { ReceiptJobStatus } from "@/components/ReceiptJobStatus";

export type PartialLine = { id: string; title: string; variant: string | null; quantity: number; price: number; refunded: number };
export type PartialJob = JobView & { order_lines: string[] | null };

const pln = (n: number) => new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN" }).format(n);

/**
 * Paragon do części zamówienia: zaznaczone pozycje (i ewentualnie koszt wysyłki) idą na osobny paragon fiskalny.
 * Pozycje z paragonem (w kolejce, drukowanym albo wydrukowanym) nie dadzą się zaznaczyć drugi raz.
 */
export function PartialReceipt({ orderId, lines, shipping, jobs }: { orderId: string; lines: PartialLine[]; shipping: number | null; jobs: PartialJob[] }) {
  const router = useRouter();
  const active = jobs.filter((j) => j.status !== "cancelled" && j.status !== "error");
  const jobOfLine = new Map<string, PartialJob>();
  for (const j of jobs.filter((x) => x.status !== "cancelled")) for (const l of j.order_lines ?? []) if (!jobOfLine.has(l) || active.includes(j)) jobOfLine.set(l, j);
  const taken = (id: string) => active.some((j) => (j.order_lines ?? []).includes(id));
  const free = [...lines.filter((l) => l.quantity - l.refunded > 0).map((l) => l.id), ...(shipping ? ["shipping"] : [])].filter((id) => !taken(id));
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const toggle = (id: string, on: boolean) => { const n = new Set(picked); if (on) n.add(id); else n.delete(id); setPicked(n); };
  const sum = lines.filter((l) => picked.has(l.id)).reduce((s, l) => s + l.price * (l.quantity - l.refunded), 0) + (picked.has("shipping") && shipping ? shipping : 0);

  const row = (id: string, label: React.ReactNode, amount: number, disabledReason: string | null) => {
    const job = jobOfLine.get(id);
    return (
      <li key={id} className="flex flex-wrap items-center gap-3 py-2">
        <label className="flex min-w-0 flex-1 items-center gap-2">
          <input type="checkbox" className="h-4 w-4" disabled={!!disabledReason || taken(id)} checked={picked.has(id)} onChange={(e) => toggle(id, e.target.checked)} />
          <span className="min-w-0">{label}</span>
        </label>
        <span className="tabular-nums text-sm">{pln(amount)}</span>
        <span className="w-full sm:w-auto">
          {job && taken(id) ? <span className="text-xs text-ok">na paragonie {job.receipt_number ? `nr ${job.receipt_number}` : `#${job.number}`}</span> : disabledReason ? <span className="text-xs text-muted">{disabledReason}</span> : null}
        </span>
      </li>
    );
  };

  return (
    <div className="space-y-3">
      <ul className="divide-y divide-line text-sm">
        {lines.map((l) => row(l.id, <>{l.title} {l.variant && <b>· {l.variant}</b>}{l.quantity > 1 && <span className="text-muted"> × {l.quantity - l.refunded}</span>}</>, l.price * Math.max(0, l.quantity - l.refunded), l.quantity - l.refunded <= 0 ? "zwrócone" : null))}
        {shipping ? row("shipping", <span>Koszt wysyłki</span>, shipping, null) : null}
      </ul>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn-secondary btn-green" disabled={pending || !picked.size} onClick={() => {
          if (!confirm(`Wydrukować paragon fiskalny do zaznaczonych pozycji (${pln(sum)})? Drukarka wydrukuje go od razu.`)) return;
          start(async () => {
            const r = await enqueuePartialReceipt(orderId, [...picked]);
            setError(r.error ?? null);
            if (r.job) { setPicked(new Set()); router.refresh(); }
          });
        }}>{pending ? "Wysyłam…" : `Drukuj paragon do zaznaczonych${picked.size ? ` (${pln(sum)})` : ""}`}</button>
        {free.length > 0 && picked.size !== free.length && (
          <button type="button" className="text-sm text-accent hover:underline" onClick={() => setPicked(new Set(free))}>zaznacz wszystko bez paragonu</button>
        )}
        {!free.length && <span className="text-sm text-ok">Wszystkie pozycje mają paragon.</span>}
      </div>
      {error && <p className="text-sm text-bad" role="alert">{error}</p>}
      {jobs.some((j) => j.status !== "cancelled") && (
        <div className="space-y-1.5 border-t border-line pt-3">
          <p className="text-xs font-medium text-muted">Paragony do tego zamówienia</p>
          {jobs.filter((j) => j.status !== "cancelled").map((j) => (
            <div key={j.id} className="flex flex-wrap items-center gap-2 text-sm">
              <ReceiptJobStatus job={j} compact onReset={() => router.refresh()} />
              <span className="text-xs text-muted">{(j.order_lines ?? []).map((id) => id === "shipping" ? "wysyłka" : lines.find((l) => l.id === id)?.title ?? "pozycja").join(", ") || "całe zamówienie"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
