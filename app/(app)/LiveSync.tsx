"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

type LiveState = { at: number | null; ok: boolean; error?: string };
const EVENT = "magazyn:live";
let current: LiveState = { at: null, ok: true };

/**
 * Odczyt na żywo, gdy aplikacja jest otwarta i widoczna (komputer i telefon): co 20 s prosi serwer o nowe zamówienia
 * i stany ze Shopify (serwer robi to najwyżej raz na 15 s dla wszystkich). Gdy przyszło coś nowego – odświeża widok.
 * Bez widoku – stan pokazuje <LiveSyncStatus /> w menu.
 */
export function LivePoller() {
  const router = useRouter();
  const path = usePathname();
  const pathRef = useRef(path);
  useEffect(() => { pathRef.current = path; }, [path]);

  useEffect(() => {
    let stop = false;
    const publish = (s: LiveState) => { current = s; window.dispatchEvent(new CustomEvent(EVENT, { detail: s })); };
    async function poll() {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/api/live", { cache: "no-store" });
        if (res.status === 429) return; // limit zapytań (np. wiele kart) – następny odczyt za chwilę
        const r = await res.json();
        if (stop) return;
        const errors: string[] = r.errors ?? (r.error ? [r.error] : []);
        publish({ at: Date.now(), ok: res.ok && !errors.length, error: errors.join("; ") || undefined });
        const stockChanged = r.stock && Object.values(r.stock as Record<string, { created?: number; removed?: number }>).some((x) => (x?.created ?? 0) + (x?.removed ?? 0) > 0);
        if ((r.orders > 0 || stockChanged) && /^\/(sprzedaz|magazyn|kasa)/.test(pathRef.current) && !document.querySelector("input:focus, textarea:focus, select:focus")) router.refresh();
      } catch {
        if (!stop) publish({ ...current, ok: false, error: "brak połączenia z aplikacją" });
      }
    }
    poll();
    const t = setInterval(poll, 20_000);
    const onVis = () => { if (document.visibilityState === "visible") poll(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => { stop = true; clearInterval(t); document.removeEventListener("visibilitychange", onVis); window.removeEventListener("focus", onVis); };
  }, [router]);
  return null;
}

/** Kropka „Shopify na żywo” w menu (stan z LivePoller). */
export function LiveSync() {
  const [state, setState] = useState<LiveState>(current);
  const [, tick] = useState(0);
  useEffect(() => {
    const on = (e: Event) => setState((e as CustomEvent<LiveState>).detail);
    window.addEventListener(EVENT, on);
    const t = setInterval(() => tick((n) => n + 1), 5_000);
    return () => { window.removeEventListener(EVENT, on); clearInterval(t); };
  }, []);
  // eslint-disable-next-line react-hooks/purity -- „ile sekund temu”, odświeżane co 5 s
  const ago = state.at ? Math.round((Date.now() - state.at) / 1000) : null;
  return (
    <div className="flex items-center gap-2 px-3 text-[11px] text-slate-500" title={state.error ? `Problem: ${state.error}` : "Zamówienia i stany ze Shopify odczytywane na bieżąco"}>
      <span className={`h-2 w-2 shrink-0 rounded-full ${state.ok ? "bg-emerald-500" : "bg-amber-500"} ${state.at ? "" : "animate-pulse"}`} />
      <span className="truncate">{state.ok ? "Shopify na żywo" : `Shopify: ${state.error ?? "problem z odczytem"}`}</span>
      {ago !== null && <span className="shrink-0 tabular-nums">· {ago < 5 ? "teraz" : `${ago} s temu`}</span>}
    </div>
  );
}
