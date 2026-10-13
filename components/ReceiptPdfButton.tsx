"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { receiptJobStatus } from "@/app/(app)/sprzedaz/receipt-actions";

/**
 * „Drukuj paragon PDF” w sprzedaży z Kasy. Gdy paragon fiskalny jeszcze się drukuje, czeka na numer z drukarki;
 * z `auto` (po „Drukuj paragon PDF” w Kasie) sam otwiera PDF, gdy tylko będzie gotowy.
 */
export function ReceiptPdfButton({ posOrderId, ready: initialReady, jobId, auto }: { posOrderId: string; ready: boolean; jobId: string | null; auto: boolean }) {
  const router = useRouter();
  const [ready, setReady] = useState(initialReady);
  const [failed, setFailed] = useState(false);
  const href = `/druk/pdf?src=${encodeURIComponent(`/api/kasa/${posOrderId}/paragon`)}&wroc=${encodeURIComponent(`/kasa/${posOrderId}`)}&nazwa=paragon&tytul=${encodeURIComponent("Paragon")}`;

  useEffect(() => {
    if (ready || !jobId) return;
    const t = setInterval(async () => {
      const j = await receiptJobStatus(jobId);
      if (j?.status === "printed") { setReady(true); clearInterval(t); }
      if (j?.status === "error" || j?.status === "cancelled") { setFailed(true); clearInterval(t); }
    }, 2500);
    return () => clearInterval(t);
  }, [ready, jobId]);

  useEffect(() => {
    if (!auto || !ready) return;
    window.history.replaceState(null, "", window.location.pathname); // „Wróć” nie otwiera PDF drugi raz
    router.push(href);
  }, [auto, ready, href, router]);

  if (ready) return <a className="btn" href={href}>Drukuj paragon PDF</a>;
  if (!jobId || failed) return null;
  return <span className="btn-secondary pointer-events-none opacity-60">{auto ? "PDF otworzy się po wydruku paragonu…" : "Paragon PDF – czekam na drukarkę…"}</span>;
}
