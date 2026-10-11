"use client";

import { useCallback, useEffect, useState } from "react";

type Img = { url: string; alt: string | null };
const sized = (url: string, w: number) => `${url}${url.includes("?") ? "&" : "?"}width=${w}`;

/** Zdjęcia produktu: miniatury, a po kliknięciu powiększenie na cały ekran (strzałki, Esc, klik = zoom). */
export function ProductGallery({ images, title }: { images: Img[]; title: string }) {
  const [open, setOpen] = useState<number | null>(null);
  const [zoom, setZoom] = useState(false);
  const go = useCallback((d: number) => { setZoom(false); setOpen((i) => (i === null ? null : (i + d + images.length) % images.length)); }, [images.length]);
  useEffect(() => {
    if (open === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, go]);
  if (!images.length) return <div className="flex h-40 items-center justify-center rounded-lg bg-panel text-sm text-muted">Brak zdjęć w Shopify</div>;

  return (
    <>
      <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
        {images.map((im, i) => (
          <button key={im.url} type="button" onClick={() => { setOpen(i); setZoom(false); }}
            className={`group relative overflow-hidden rounded-lg border border-line bg-white transition hover:border-accent hover:shadow-md ${i === 0 ? "col-span-2 row-span-2" : ""}`}
            aria-label={`Powiększ zdjęcie ${i + 1}`}>
            <img src={sized(im.url, i === 0 ? 600 : 240)} alt={im.alt ?? title} className="aspect-square h-full w-full object-contain p-1 transition group-hover:scale-105" loading="lazy" />
            <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white opacity-0 transition group-hover:opacity-100">powiększ</span>
          </button>
        ))}
      </div>
      {open !== null && (
        <div className="fixed inset-0 z-[100] flex flex-col bg-black/90" role="dialog" aria-modal="true" aria-label="Zdjęcie produktu" onClick={() => setOpen(null)}>
          <div className="flex items-center justify-between p-3 text-sm text-white" onClick={(e) => e.stopPropagation()}>
            <span>{open + 1} / {images.length} · {title}</span>
            <span className="flex gap-2">
              <button type="button" className="rounded bg-white/15 px-3 py-1.5 hover:bg-white/30" onClick={() => setZoom((z) => !z)}>{zoom ? "Dopasuj" : "Powiększ 2×"}</button>
              <a className="rounded bg-white/15 px-3 py-1.5 hover:bg-white/30" href={images[open].url} target="_blank" rel="noreferrer">Oryginał</a>
              <button type="button" className="rounded bg-white/15 px-3 py-1.5 hover:bg-white/30" onClick={() => setOpen(null)} aria-label="Zamknij">✕</button>
            </span>
          </div>
          <div className={`relative flex-1 ${zoom ? "overflow-auto" : "flex items-center justify-center overflow-hidden"}`} onClick={(e) => e.stopPropagation()}>
            <img src={sized(images[open].url, zoom ? 2400 : 1400)} alt={images[open].alt ?? title}
              className={zoom ? "max-w-none cursor-zoom-out" : "max-h-full max-w-full cursor-zoom-in object-contain"}
              style={zoom ? { width: "200%" } : undefined} onClick={() => setZoom((z) => !z)} />
            {images.length > 1 && !zoom && (
              <>
                <button type="button" className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full bg-white/20 px-4 py-3 text-2xl text-white hover:bg-white/40" onClick={() => go(-1)} aria-label="Poprzednie">‹</button>
                <button type="button" className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-white/20 px-4 py-3 text-2xl text-white hover:bg-white/40" onClick={() => go(1)} aria-label="Następne">›</button>
              </>
            )}
          </div>
          {images.length > 1 && (
            <div className="flex justify-center gap-2 overflow-x-auto p-3" onClick={(e) => e.stopPropagation()}>
              {images.map((im, i) => (
                <button key={im.url} type="button" onClick={() => { setOpen(i); setZoom(false); }} className={`h-14 w-14 flex-none overflow-hidden rounded border-2 bg-white ${i === open ? "border-white" : "border-transparent opacity-60 hover:opacity-100"}`}>
                  <img src={sized(im.url, 120)} alt="" className="h-full w-full object-contain" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
