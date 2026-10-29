"use client";

import type { JobView } from "@/app/(app)/sprzedaz/receipt-actions";

/**
 * Wspólne odświeżanie stanu paragonów w kolejce: jedno zapytanie dla wszystkich paragonów na stronie,
 * na początku co 3 s, potem rzadziej (paragon czeka dłużej – np. program drukarki wyłączony),
 * w ukrytej karcie wcale. Zwykły GET – nie blokuje akcji (kliknięć) w aplikacji.
 */
type Cb = (j: JobView) => void;
const subs = new Map<string, Set<Cb>>();
let timer: ReturnType<typeof setTimeout> | null = null;
let since = 0;
let listening = false;

const delay = () => {
  const age = Date.now() - since;
  return age < 60_000 ? 3_000 : age < 300_000 ? 10_000 : 30_000;
};

async function tick() {
  timer = null;
  if (!subs.size) return;
  if (document.visibilityState === "visible") {
    try {
      const ids = [...subs.keys()].slice(0, 50);
      const res = await fetch(`/api/paragony/status?ids=${ids.join(",")}`, { cache: "no-store" });
      if (res.ok) {
        const list = (await res.json()) as JobView[];
        for (const j of list) subs.get(j.id)?.forEach((cb) => cb(j));
      }
    } catch {
      // brak sieci – następna próba za chwilę
    }
  }
  schedule();
}

function schedule(ms = delay()) {
  if (timer || !subs.size) return;
  timer = setTimeout(tick, ms);
}

function onVisible() {
  if (document.visibilityState !== "visible" || !subs.size) return;
  if (timer) clearTimeout(timer);
  timer = null;
  schedule(300);
}

/** Obserwuj paragon; zwraca funkcję kończącą obserwację. */
export function watchReceiptJob(id: string, cb: Cb) {
  if (!listening) {
    document.addEventListener("visibilitychange", onVisible);
    listening = true;
  }
  // Nowy paragon (np. właśnie kliknięty) – znów częste odświeżanie.
  since = Date.now();
  if (timer) { clearTimeout(timer); timer = null; }
  subs.set(id, (subs.get(id) ?? new Set()).add(cb));
  schedule();
  return () => {
    const s = subs.get(id);
    s?.delete(cb);
    if (s && !s.size) subs.delete(id);
    if (!subs.size && timer) { clearTimeout(timer); timer = null; }
  };
}
