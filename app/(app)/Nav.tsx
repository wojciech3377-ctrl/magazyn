"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { signOut } from "@/app/login/actions";
import { Icon, type IconName } from "@/components/icons";
import { LiveSync } from "./LiveSync";

type NavLink = { href: string; label: string; icon: IconName };
const GROUPS: { title: string; links: NavLink[] }[] = [
  {
    title: "Codzienna praca",
    links: [
      { href: "/do-zrobienia", label: "Do zrobienia", icon: "check" },
      { href: "/magazyn", label: "Magazyn", icon: "box" },
      { href: "/dostawa", label: "Przyjęcie dostawy", icon: "truck" },
      { href: "/kasa", label: "Kasa", icon: "cash" },
      { href: "/sprzedaz", label: "Sprzedaż", icon: "cart" },
    ],
  },
  {
    title: "Zakup i komis",
    links: [
      { href: "/umowy", label: "Umowy", icon: "file" },
      { href: "/komisanci", label: "Komisanci", icon: "users" },
      { href: "/wtb", label: "WTB", icon: "heart" },
    ],
  },
  {
    title: "Dane",
    links: [
      { href: "/katalog", label: "Katalog", icon: "grid" },
      { href: "/pracownicy", label: "Pracownicy", icon: "shield" },
      { href: "/ustawienia", label: "Ustawienia", icon: "settings" },
    ],
  },
];

type Badge = { n: number; tone: "red" | "green" | "orange"; title: string };
const TONE = { red: "bg-red-500", green: "bg-emerald-500", orange: "bg-orange-500" };

/** Dolny pasek na telefonie: najważniejsze działy (do 4) i „Menu”. */
const TAB_BAR = ["/magazyn", "/kasa", "/sprzedaz", "/dostawa", "/wtb", "/katalog"];

/** Menu boczne (komputer), wysuwane menu i dolny pasek (telefon). Tylko działy, do których osoba ma dostęp. */
export function Nav({ badges = {}, user, allowed }: { badges?: Record<string, Badge[]>; user: string; allowed: string[] }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]);
  const groups = GROUPS.map((g) => ({ ...g, links: g.links.filter((l) => allowed.includes(l.href)) })).filter((g) => g.links.length);
  const all = groups.flatMap((g) => g.links);
  const current = all.find((l) => path === l.href || path.startsWith(l.href + "/"));
  const tabs = TAB_BAR.map((h) => all.find((l) => l.href === h)).filter((l): l is NavLink => !!l).slice(0, 4);
  const anyBadge = Object.values(badges).flat().some((b) => b.n > 0);
  const initials = user.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((x) => x[0]?.toUpperCase()).join("");

  const menu = (
    <div className="flex h-full flex-col">
      <Link href="/magazyn" className="flex items-center gap-2.5 px-5 pb-5 pt-5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-indigo-500 text-white shadow-sm"><Icon name="box" className="h-4.5 w-4.5" /></span>
        <span className="leading-tight">
          <span className="block text-[15px] font-semibold tracking-tight">Magazyn</span>
          <span className="block text-[11px] text-muted">Telefoniki · Sneakers Depot</span>
        </span>
      </Link>
      <nav className="flex-1 space-y-5 overflow-y-auto px-3" aria-label="Menu główne">
        {groups.map((g) => (
          <div key={g.title}>
            <div className="px-2 pb-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-400">{g.title}</div>
            <ul className="space-y-0.5">
              {g.links.map((l) => {
                const active = current?.href === l.href;
                const bs = (badges[l.href] ?? []).filter((b) => b.n > 0);
                return (
                  <li key={l.href}>
                    <Link
                      href={l.href}
                      aria-current={active ? "page" : undefined}
                      className={`group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${active ? "bg-accent-soft text-accent" : "text-slate-600 hover:bg-slate-100 hover:text-ink"}`}
                    >
                      <Icon name={l.icon} className={`h-[18px] w-[18px] shrink-0 ${active ? "text-accent" : "text-slate-400 group-hover:text-slate-600"}`} />
                      <span className="flex-1 truncate">{l.label}</span>
                      {bs.map((b) => (
                        <span key={b.tone} className={`min-w-5 rounded-full px-1.5 py-px text-center text-[11px] font-semibold text-white tabular-nums ${TONE[b.tone]}`} title={b.title}>{b.n}</span>
                      ))}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      <LiveSync />
      <form action={signOut} className="m-3 mt-2 flex items-center gap-2.5 rounded-xl border border-line bg-slate-50/80 p-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-slate-700">{initials || "?"}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-slate-700" title={user}>{user}</span>
        <button className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white hover:text-ink" title="Wyloguj" aria-label="Wyloguj"><Icon name="logout" className="h-4 w-4" /></button>
      </form>
    </div>
  );

  return (
    <>
      {/* Komputer: stałe menu z lewej. */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-line bg-white lg:block print:hidden">{menu}</aside>

      {/* Telefon / tablet: górny pasek i wysuwane menu. */}
      {/* Telefon: menu w dolnym pasku – górny pasek tylko na tablecie (md–lg). */}
      <header className="sticky top-0 z-30 hidden items-center gap-3 border-b border-line bg-white/90 px-4 py-2.5 backdrop-blur md:flex lg:hidden print:hidden">
        <button className="btn-ghost -ml-2 h-9 w-9 px-0" onClick={() => setOpen(true)} aria-label="Otwórz menu" aria-expanded={open}><Icon name="menu" className="h-5 w-5" /></button>
        <span className="font-semibold tracking-tight">{current?.label ?? "Magazyn"}</span>
        {anyBadge && <span className="ml-auto h-2 w-2 rounded-full bg-red-500" title="Coś czeka na obsłużenie" />}
      </header>

      {/* Telefon: dolny pasek jak w aplikacji. */}
      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden print:hidden" aria-label="Szybkie menu">
        <ul className="mx-auto flex max-w-lg">
          {tabs.map((l) => {
            const active = current?.href === l.href;
            const n = (badges[l.href] ?? []).reduce((s, b) => s + b.n, 0);
            return (
              <li key={l.href} className="flex-1">
                <Link href={l.href} aria-current={active ? "page" : undefined} className={`relative flex flex-col items-center gap-0.5 pb-1.5 pt-2 text-[11px] font-medium ${active ? "text-accent" : "text-slate-500"}`}>
                  <Icon name={l.icon} className="h-[22px] w-[22px]" />
                  {l.label === "Przyjęcie dostawy" ? "Dostawa" : l.label}
                  {n > 0 && <span className="absolute left-1/2 top-1 ml-2 min-w-4 rounded-full bg-red-500 px-1 text-center text-[10px] font-semibold leading-4 text-white">{n}</span>}
                </Link>
              </li>
            );
          })}
          <li className="flex-1">
            <button type="button" onClick={() => setOpen(true)} className={`relative flex w-full flex-col items-center gap-0.5 pb-1.5 pt-2 text-[11px] font-medium ${current && !tabs.includes(current) ? "text-accent" : "text-slate-500"}`}>
              <Icon name="menu" className="h-[22px] w-[22px]" />
              Więcej
              {anyBadge && tabs.every((t) => !(badges[t.href] ?? []).some((b) => b.n > 0)) && <span className="absolute left-1/2 top-1.5 ml-2 h-2 w-2 rounded-full bg-red-500" />}
            </button>
          </li>
        </ul>
      </nav>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-white shadow-(--shadow-pop)">
            <button className="btn-ghost absolute right-2 top-3 h-9 w-9 px-0" onClick={() => setOpen(false)} aria-label="Zamknij menu"><Icon name="close" className="h-5 w-5" /></button>
            {menu}
          </div>
        </div>
      )}
    </>
  );
}
