"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

/**
 * Odczyt na żywo, gdy aplikacja jest otwarta i widoczna: co 20 s prosi serwer o nowe zamówienia i stany ze Shopify
 * (serwer robi to najwyżej raz na 15 s dla wszystkich). Gdy przyszło coś nowego – odświeża bieżący widok.
 */
export function LiveSync() {
  const router = useRouter();
  const path = usePathname();
  const pathRef = useRef(path);
  pathRef.current = path;
  const [state, setState] = useState<{ at: number | null; ok: boolean }>({ at: null, ok: true });
  const [, tick] = useState(0);

  useEffect(() => {
    let stop = false;
    async function poll() {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/api/live", { cache: "no-store" });
        const r = await res.json();
        if (stop) return;
        setState({ at: Date.now(), ok: res.ok && !(r.errors?.length) });
        const stockChanged = r.stock && Object.values(r.stock as Record<string, { created?: number; removed?: number }>).some((x) => (x?.created ?? 0) + (x?.removed ?? 0) > 0);
        if ((r.orders > 0 || stockChanged) && /^\/(sprzedaz|magazyn|kasa)/.test(pathRef.current) && !document.querySelector("input:focus, textarea:focus, select:focus")) router.refresh();
      } catch {
        if (!stop) setState((s) => ({ ...s, ok: false }));
      }
    }
    poll();
    const t = setInterval(poll, 20_000);
    const t2 = setInterval(() => tick((n) => n + 1), 5_000);
    const onVis = () => { if (document.visibilityState === "visible") poll(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { stop = true; clearInterval(t); clearInterval(t2); document.removeEventListener("visibilitychange", onVis); };
  }, [router]);

  const ago = state.at ? Math.round((Date.now() - state.at) / 1000) : null;
  return (
    <div className="flex items-center gap-2 px-3 text-[11px] text-slate-500" title="Zamówienia i stany ze Shopify odczytywane na bieżąco">
      <span className={`h-2 w-2 rounded-full ${state.ok ? "bg-emerald-500" : "bg-amber-500"} ${state.at ? "" : "animate-pulse"}`} />
      {state.ok ? "Shopify na żywo" : "Shopify: problem z odczytem"}{ago !== null && <span className="tabular-nums">· {ago < 5 ? "teraz" : `${ago} s temu`}</span>}
    </div>
  );
}
