"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { IScannerControls } from "@zxing/browser";
import { Icon } from "@/components/icons";

/** Krótki sygnał po odczycie kodu (iPhone nie ma wibracji w przeglądarce). */
function beep() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 1320;
    g.gain.setValueAtTime(0.08, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.13);
    setTimeout(() => ctx.close(), 300);
  } catch {
    // bez dźwięku
  }
  navigator.vibrate?.(60);
}

function cameraError(e: unknown) {
  const name = (e as { name?: string })?.name ?? "";
  if (!window.isSecureContext) return "Aparat działa tylko na stronie https.";
  if (name === "NotAllowedError" || name === "SecurityError") return "Brak zgody na aparat. Na iPhonie: Ustawienia → Safari → Aparat → Zezwalaj (albo „Aa” → Ustawienia witryny), potem spróbuj ponownie.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "Nie znaleziono aparatu w tym urządzeniu.";
  if (name === "NotReadableError") return "Aparat jest zajęty przez inną aplikację.";
  return "Nie udało się włączyć aparatu.";
}

/**
 * Skaner kodów kreskowych i QR aparatem telefonu (pełny ekran). Czyta kody sztuk (CODE128), EAN, UPC, QR.
 * `continuous` – zostaje otwarty i czyta kolejne kody (inwentaryzacja, kasa); inaczej zamyka się po pierwszym.
 */
export function BarcodeScanner({ onResult, onClose, continuous, skip, title = "Skanuj kod" }: {
  onResult: (code: string) => void;
  onClose: () => void;
  continuous?: boolean;
  /** Poprzednio zeskanowany kod – pomijany (aparat często wciąż na niego patrzy po ponownym otwarciu). */
  skip?: string;
  title?: string;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const controls = useRef<IScannerControls | null>(null);
  const last = useRef<{ code: string; at: number }>({ code: "", at: 0 });
  // Kody przyjęte w tym otwarciu skanera – drugi raz ten sam kod nie jest liczony (trzeba nakierować na kolejny).
  const seen = useRef<Set<string>>(new Set(skip ? [skip.toUpperCase()] : []));
  const [notice, setNotice] = useState<string | null>(null);
  const result = useRef(onResult);
  useEffect(() => { result.current = onResult; }, [onResult]);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [torch, setTorch] = useState<boolean | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [count, setCount] = useState(0);

  useEffect(() => {
    let stopped = false;
    let mine: IScannerControls | null = null;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Własny element <video> dla każdego uruchomienia – zatrzymanie poprzedniego nie czyści bieżącego obrazu.
    const video = document.createElement("video");
    video.className = "absolute inset-0 h-full w-full object-cover";
    video.playsInline = true;
    video.muted = true;
    video.autoplay = true;
    video.setAttribute("playsinline", "");
    stage.current?.appendChild(video);
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error("no media"), { name: window.isSecureContext ? "NotFoundError" : "SecurityError" });
        const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([import("@zxing/browser"), import("@zxing/library")]);
        const hints = new Map();
        hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128, BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E, BarcodeFormat.CODE_39, BarcodeFormat.ITF, BarcodeFormat.QR_CODE, BarcodeFormat.DATA_MATRIX]);
        hints.set(DecodeHintType.TRY_HARDER, true);
        const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 80, delayBetweenScanSuccess: 600 });
        const c = await reader.decodeFromConstraints(
          { audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } } },
          video,
          (res) => {
            if (!res || stopped) return;
            const code = res.getText().trim();
            if (!code) return;
            const now = Date.now();
            if (seen.current.has(code.toUpperCase())) {
              // Ten sam przedmiot co wcześniej – czekamy na kolejny kod.
              if (code !== last.current.code || now - last.current.at > 2500) {
                last.current = { code, at: now };
                setNotice(`${code} już zeskanowany – nakieruj na kolejny kod`);
              }
              return;
            }
            last.current = { code, at: now };
            seen.current.add(code.toUpperCase());
            setNotice(null);
            beep();
            if (continuous) {
              setFlash(code);
              setCount((n) => n + 1);
              result.current(code);
            } else {
              stopped = true;
              mine?.stop();
              result.current(code);
            }
          },
        );
        mine = c;
        if (stopped) { c.stop(); return; }
        controls.current = c;
        setReady(true);
        // Latarka – tylko gdy aparat ją obsługuje (część Androidów; iPhone w przeglądarce zwykle nie).
        const caps = c.streamVideoCapabilitiesGet?.((t) => [t]) as (MediaTrackCapabilities & { torch?: boolean }) | undefined;
        if (caps?.torch && c.switchTorch) setTorch(false);
      } catch (e) {
        if (!stopped) setError(cameraError(e));
      }
    })();
    return () => {
      stopped = true;
      mine?.stop();
      video.remove();
      document.body.style.overflow = prev;
    };
  }, [continuous]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 2200);
    return () => clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(t);
  }, [flash]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[100] flex flex-col bg-black text-white" role="dialog" aria-modal="true" aria-label={title}>
      <div ref={stage} className="absolute inset-0" />
      {/* Ramka celownika z przyciemnieniem dookoła. */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="relative h-[38%] max-h-64 w-[82%] max-w-md rounded-3xl shadow-[0_0_0_200vmax_rgb(0_0_0/0.45)]">
          {["left-0 top-0 border-l-4 border-t-4 rounded-tl-3xl", "right-0 top-0 border-r-4 border-t-4 rounded-tr-3xl", "bottom-0 left-0 border-b-4 border-l-4 rounded-bl-3xl", "bottom-0 right-0 border-b-4 border-r-4 rounded-br-3xl"].map((c) => (
            <span key={c} className={`absolute h-10 w-10 border-white ${c}`} />
          ))}
          {ready && !error && <span className="absolute inset-x-6 top-1/2 h-0.5 animate-pulse rounded-full bg-red-500/90 shadow-[0_0_12px_rgb(239_68_68)]" />}
        </div>
      </div>

      <div className="relative flex items-center justify-between gap-3 px-4 pb-3 pt-[max(1rem,env(safe-area-inset-top))]">
        <span className="rounded-full bg-black/40 px-3 py-1.5 text-sm font-medium backdrop-blur">{title}{continuous && count > 0 ? ` · ${count}` : ""}</span>
        <button type="button" onClick={onClose} className="flex h-11 w-11 items-center justify-center rounded-full bg-black/40 backdrop-blur hover:bg-black/60" aria-label="Zamknij skaner">
          <Icon name="close" className="h-6 w-6" />
        </button>
      </div>

      <div className="relative mt-auto space-y-3 px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] text-center">
        {flash && <div className="mx-auto w-fit max-w-full truncate rounded-full bg-emerald-500 px-4 py-2 font-mono text-sm font-semibold shadow-lg">✓ {flash}</div>}
        {notice && !flash && <div className="mx-auto w-fit max-w-full rounded-full bg-amber-400 px-4 py-2 text-sm font-semibold text-black shadow-lg">{notice}</div>}
        {error ? (
          <div className="mx-auto max-w-sm rounded-2xl bg-white p-4 text-left text-sm text-ink shadow-lg">
            <p className="font-semibold">Aparat niedostępny</p>
            <p className="mt-1 text-muted">{error}</p>
            <button type="button" className="btn mt-3 w-full" onClick={onClose}>Wpisz kod ręcznie</button>
          </div>
        ) : (
          <p className="text-sm text-white/85">{ready ? "Nakieruj aparat na kod kreskowy albo QR" : "Włączam aparat…"}</p>
        )}
        <div className="flex justify-center gap-3">
          {torch !== null && (
            <button type="button" onClick={async () => { await controls.current?.switchTorch?.(!torch); setTorch(!torch); }}
              className={`flex h-12 items-center gap-2 rounded-full px-5 text-sm font-medium backdrop-blur ${torch ? "bg-amber-400 text-black" : "bg-white/15"}`}>
              <Icon name="flash" className="h-5 w-5" /> Latarka
            </button>
          )}
          {continuous && <button type="button" onClick={onClose} className="h-12 rounded-full bg-white px-6 text-sm font-semibold text-ink">Gotowe</button>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
