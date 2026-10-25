"use client";

import { useEffect, useState } from "react";

type Platform = "ios" | "android" | "other";
type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

const KEY = "komis-install-guide-hidden";

/** Poradnik: panel komisanta jako aplikacja na telefonie (ikona na ekranie głównym, bez paska przeglądarki). */
export function InstallGuide() {
  const [platform, setPlatform] = useState<Platform>("other");
  const [installed, setInstalled] = useState(false);
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);

  useEffect(() => {
    const ua = navigator.userAgent;
    // iPad z iPadOS przedstawia się jak Mac – rozpoznajemy po ekranie dotykowym.
    const ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    setPlatform(ios ? "ios" : /Android/i.test(ua) ? "android" : "other");
    const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
    setInstalled(standalone);
    let wasHidden = false;
    try { wasHidden = localStorage.getItem(KEY) === "1"; } catch { /* bez pamięci przeglądarki – pokazujemy */ }
    setOpen(!wasHidden && (ios || /Android/i.test(ua)));
    const onPrompt = (e: Event) => { e.preventDefault(); setPrompt(e as InstallPrompt); };
    const onInstalled = () => { setInstalled(true); setPrompt(null); };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => { window.removeEventListener("beforeinstallprompt", onPrompt); window.removeEventListener("appinstalled", onInstalled); };
  }, []);

  if (installed) return null;

  const hide = () => {
    setOpen(false);
    try { localStorage.setItem(KEY, "1"); } catch { /* bez pamięci przeglądarki */ }
  };

  if (!open) {
    return (
      <p className="mb-4 text-right text-sm">
        <button type="button" className="text-accent hover:underline" onClick={() => setOpen(true)}>📱 Panel jako aplikacja na telefonie</button>
      </p>
    );
  }

  const step = (n: number, body: React.ReactNode) => (
    <li className="flex gap-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-white">{n}</span>
      <span className="pt-0.5">{body}</span>
    </li>
  );

  const ios = (
    <div className="space-y-2">
      <h3 className="font-medium">iPhone / iPad</h3>
      <ol className="space-y-2">
        {step(1, <>Otwórz ten panel w <b>Safari</b> (w Chrome na iPhonie też działa).</>)}
        {step(2, <>Stuknij <b>Udostępnij</b> <ShareIcon /> na dolnym pasku. W nowszym iOS najpierw stuknij <b>⋯</b> (trzy kropki) w prawym dolnym rogu, potem <b>Udostępnij</b>.</>)}
        {step(3, <>Przewiń listę w dół i wybierz <b>„Do ekranu początkowego”</b> <PlusIcon />.</>)}
        {step(4, <>Zostaw włączone <b>„Otwórz jako aplikację”</b> (jeśli jest) i stuknij <b>Dodaj</b> w prawym górnym rogu.</>)}
        {step(5, <>Na ekranie telefonu pojawi się ikona <b>„Mój komis”</b>. Przy pierwszym otwarciu zaloguj się jeszcze raz – dalej panel pamięta logowanie.</>)}
      </ol>
    </div>
  );

  const android = (
    <div className="space-y-2">
      <h3 className="font-medium">Android</h3>
      {prompt && (
        <button type="button" className="btn" onClick={async () => { await prompt.prompt(); const r = await prompt.userChoice; if (r.outcome === "accepted") setInstalled(true); setPrompt(null); }}>
          Dodaj do ekranu głównego
        </button>
      )}
      <ol className="space-y-2">
        {step(1, <>Otwórz ten panel w <b>Chrome</b>.</>)}
        {step(2, <>Stuknij <b>⋮</b> (trzy kropki) w prawym górnym rogu.</>)}
        {step(3, <>Wybierz <b>„Dodaj do ekranu głównego”</b> albo <b>„Zainstaluj aplikację”</b>, potem <b>Zainstaluj</b> / <b>Dodaj</b>.</>)}
        {step(4, <>Ikona <b>„Mój komis”</b> pojawi się na ekranie telefonu. W przeglądarce Samsung: menu <b>≡</b> → <b>„Dodaj stronę do”</b> → <b>„Ekran startowy”</b>.</>)}
      </ol>
    </div>
  );

  return (
    <section className="card mb-5 space-y-3 p-4 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">📱 Panel jako aplikacja na telefonie</h2>
          <p className="text-muted">Dodaj panel do ekranu głównego – otworzysz go jednym stuknięciem, na pełnym ekranie, bez szukania linku.</p>
        </div>
        <button type="button" className="shrink-0 text-xs text-muted hover:text-ink" onClick={hide}>ukryj</button>
      </div>
      {platform === "ios" && ios}
      {platform === "android" && android}
      {platform === "other" && (
        <>
          <p className="text-muted">Otwórz ten panel na telefonie (ten sam adres, zaloguj się) i zrób to tam:</p>
          <div className="grid gap-4 sm:grid-cols-2">{ios}{android}</div>
        </>
      )}
    </section>
  );
}

function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" className="inline h-4 w-4 align-[-2px] text-accent" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-label="ikona Udostępnij">
      <path d="M12 3v12" /><path d="m8 7 4-4 4 4" /><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" className="inline h-4 w-4 align-[-2px] text-accent" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-label="ikona plusa w kwadracie">
      <rect x="4" y="4" width="16" height="16" rx="3" /><path d="M12 8v8M8 12h8" />
    </svg>
  );
}
