"use client";

import { useEffect, useState } from "react";
import { printPdf } from "@/components/PrintPdf";

const isIos = () =>
  typeof navigator !== "undefined" && (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

export function PdfViewer({ src, back, next, nextLabel, name, title }: { src: string; back: string; next?: string | null; nextLabel?: string; name: string; title: string }) {
  const [file, setFile] = useState<{ url: string; blob: File } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [canShare, setCanShare] = useState(false);
  const [ios, setIos] = useState(false);

  useEffect(() => {
    let url: string | null = null;
    (async () => {
      try {
        const res = await fetch(src, { cache: "no-store" });
        const type = res.headers.get("content-type") ?? "";
        if (!res.ok || !type.includes("pdf")) throw new Error((await res.text().catch(() => "")).slice(0, 300) || `Błąd ${res.status}`);
        const blob = new File([await res.blob()], name, { type: "application/pdf" });
        url = URL.createObjectURL(blob);
        setFile({ url, blob });
        setCanShare(!!navigator.canShare?.({ files: [blob] }));
        setIos(isIos());
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [src, name]);

  const share = async () => {
    if (!file) return;
    try {
      await navigator.share({ files: [file.blob], title });
    } catch {
      // zamknięte okno udostępniania – nic nie robimy
    }
  };
  const goBack = () => { window.location.href = back; };

  return (
    <div className="fixed inset-0 flex flex-col bg-slate-100">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-white px-3 py-2" style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}>
        <button type="button" className="btn-secondary" onClick={goBack}>← Wróć</button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
        {file && (
          <>
            {/* iPhone: drukowanie przez okno „Udostępnij” (tam jest „Drukuj” i „Zapisz w Plikach”). */}
            {ios && canShare ? (
              <button type="button" className="btn" onClick={share}>Drukuj / Udostępnij</button>
            ) : (
              <>
                <button type="button" className="btn" onClick={() => printPdf(file.url)}>Drukuj</button>
                {canShare && <button type="button" className="btn-secondary" onClick={share}>Udostępnij</button>}
              </>
            )}
            <a className="btn-secondary" href={file.url} download={name}>Pobierz</a>
          </>
        )}
        {next && <a className="btn bg-emerald-600 hover:bg-emerald-700" href={next}>{nextLabel ?? "Dalej"} →</a>}
      </div>
      {error ? (
        <p className="m-4 rounded-lg bg-red-50 p-3 text-sm text-bad">Nie udało się otworzyć dokumentu: {error}</p>
      ) : file ? (
        <iframe src={file.url} title={title} className="min-h-0 w-full flex-1 bg-white" />
      ) : (
        <p className="m-4 text-sm text-muted">Wczytuję dokument…</p>
      )}
    </div>
  );
}
