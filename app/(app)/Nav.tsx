"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/magazyn", label: "Magazyn" },
  { href: "/dostawa", label: "Przyjęcie dostawy" },
  { href: "/kasa", label: "Kasa" },
  { href: "/sprzedaz", label: "Sprzedaż" },
  { href: "/umowy", label: "Umowy" },
  { href: "/wtb", label: "WTB" },
  { href: "/katalog", label: "Katalog" },
  { href: "/komisanci", label: "Komisanci" },
  { href: "/ustawienia", label: "Ustawienia" },
];

type Badge = { n: number; tone: "red" | "green" | "orange"; title: string };
const TONE = { red: "bg-bad", green: "bg-emerald-600", orange: "bg-orange-500" };

export function Nav({ badges = {} }: { badges?: Record<string, Badge[]> }) {
  const path = usePathname();
  return (
    <nav className="-mx-4 flex min-w-0 gap-1 overflow-x-auto px-4 text-sm md:mx-0 md:px-0">
      {LINKS.map((l) => {
        const active = path === l.href || path.startsWith(l.href + "/");
        return (
          <Link
            key={l.href}
            href={l.href}
            className={`whitespace-nowrap rounded-md px-3 py-1.5 ${active ? "bg-ink text-white" : "text-muted hover:bg-panel hover:text-ink"}`}
          >
            {l.label}
            {(badges[l.href] ?? []).filter((b) => b.n > 0).map((b) => (
              <span key={b.tone} className={`ml-1.5 rounded-full px-1.5 py-0.5 text-xs font-semibold text-white tabular-nums ${TONE[b.tone]}`} title={b.title}>{b.n}</span>
            ))}
          </Link>
        );
      })}
    </nav>
  );
}
