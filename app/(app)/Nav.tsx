"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/magazyn", label: "Magazyn" },
  { href: "/dostawa", label: "Przyjęcie dostawy" },
  { href: "/kasa", label: "Kasa" },
  { href: "/sprzedaz", label: "Sprzedaż" },
  { href: "/umowy", label: "Umowy" },
  { href: "/katalog", label: "Katalog" },
  { href: "/komisanci", label: "Komisanci" },
  { href: "/ustawienia", label: "Ustawienia" },
];

export function Nav() {
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
          </Link>
        );
      })}
    </nav>
  );
}
