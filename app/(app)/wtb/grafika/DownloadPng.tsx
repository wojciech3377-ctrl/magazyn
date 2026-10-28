"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Pobranie grafiki bez wychodzenia ze strony: telefon – menu „Udostępnij” (Zapisz obraz / wyślij dalej),
 * komputer – zwykłe pobranie pliku. Wcześniej link otwierał sam obrazek, a w aplikacji z ekranu głównego
 * (bez paska przeglądarki) nie dało się wrócić.
 * Grafika pobiera się zawczasu – iPhone pozwala otworzyć „Udostępnij” tylko od razu po stuknięciu.
 */
export function DownloadPng({ src, name }: { src: string; name: string }) {
  const blob = useRef<Blob | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    fetch(src, { cache: "force-cache" })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`błąd ${r.status}`))))
      .then((b) => { if (!stop) { blob.current = b; setReady(true); } })
      .catch((e) => { if (!stop) setError(`Nie udało się przygotować grafiki (${(e as Error).message}).`); });
    return () => { stop = true; };
  }, [src]);

  function save() {
    const b = blob.current;
    if (!b) return;
    const file = new File([b], name, { type: "image/png" });
    const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
    if (window.matchMedia("(pointer: coarse)").matches && nav.canShare?.({ files: [file] })) {
      nav.share({ files: [file], title: name }).catch((e) => {
        if ((e as Error).name !== "AbortError") download(b);
      });
      return;
    }
    download(b);
  }
  function download(b: Blob) {
    const url = URL.createObjectURL(b);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button type="button" className="btn" onClick={save} disabled={!ready}>{ready ? "Pobierz PNG" : error ? "Pobierz PNG" : "Przygotowuję…"}</button>
      {error && <span className="text-xs text-bad">{error}</span>}
    </span>
  );
}
