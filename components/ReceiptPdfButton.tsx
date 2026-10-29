"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { watchReceiptJob } from "@/components/receipt-poll";

/**
 * „Drukuj paragon PDF” w sprzedaży z Kasy. Gdy paragon fiskalny jeszcze się drukuje, czeka na numer z drukarki;
 * z `auto` (po „Drukuj paragon PDF” w Kasie) sam otwiera PDF, gdy tylko będzie gotowy.
 */
export function ReceiptPdfButton({ posOrderId, ready: initialReady, jobId, auto }: { posOrderId: string; ready: boolean; jobId: string | null; auto: boolean }) {
  const router = useRouter();
  const [ready, setReady] = useState(initialReady);
  const [failed, setFailed] = useState(false);
  const href = `/druk/pdf?src=${encodeURIComponent(`/api/kasa/${posOrderId}/paragon`)}&wroc=${encodeURIComponent(`/kasa/${posOrderId}`)}&dalej=${encodeURIComponent("/kasa")}&dalej_tekst=${encodeURIComponent("Nowa sprzedaż")}&nazwa=paragon&tytul=${encodeURIComponent("Paragon")}`;

  useEffect(() => {
    if (ready || !jobId) return;
    return watchReceiptJob(jobId, (j) => {
      if (j.status === "printed") setReady(true);
      if (j.status === "error" || j.status === "cancelled") setFailed(true);
    });
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
