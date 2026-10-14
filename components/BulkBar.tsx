"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { HScrollBar } from "@/components/HScrollBar";

/**
 * Akcje dla zaznaczonych wierszy listy (pola `ids` w tym samym formularzu).
 * Komputer: pasek przyklejony do dołu listy. Telefon: pojawia się dopiero po zaznaczeniu – „N zaznaczone · Akcje”,
 * akcje rozwijają się w panelu nad dolnym menu.
 */
export function BulkBar({ children, name = "ids", scrollFor }: { children: React.ReactNode; name?: string; /** id przewijanej tabeli – pasek przewijania w bok nad akcjami (komputer). */ scrollFor?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    const update = () => setCount(form.querySelectorAll(`input[name="${name}"]:checked`).length);
    update();
    form.addEventListener("change", update);
    return () => form.removeEventListener("change", update);
  }, [name]);
  useEffect(() => { if (!count) setOpen(false); }, [count]);

  return (
    <div ref={ref} className={`z-20 mt-3 rounded-xl border border-line bg-white/95 shadow-(--shadow-pop) backdrop-blur max-md:fixed max-md:inset-x-2 max-md:bottom-[calc(4.6rem+env(safe-area-inset-bottom))] md:sticky md:bottom-[calc(4.6rem+env(safe-area-inset-bottom))] md:shadow-none lg:bottom-0 ${count ? "" : "max-md:hidden"}`}>
      {scrollFor && <HScrollBar target={scrollFor} className="mx-auto h-4 rounded-t-xl border-b border-line max-md:hidden" />}
      <div className="flex items-center gap-3 px-3 py-2.5 md:hidden">
        <span className="flex h-7 min-w-7 items-center justify-center rounded-full bg-accent px-2 text-sm font-semibold text-white">{count}</span>
        <span className="text-sm font-medium">zaznaczone</span>
        <button type="button" className="btn ml-auto h-9" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          Akcje <Icon name="chevron" className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : "-rotate-90"}`} />
        </button>
      </div>
      <div className={`flex-wrap items-end gap-2 p-3 max-md:max-h-[55dvh] max-md:flex-col max-md:items-stretch max-md:overflow-y-auto max-md:border-t max-md:border-line md:flex ${open ? "flex" : "hidden"}`}>
        <span className="mr-2 hidden text-sm text-muted md:inline">Zaznaczone{count ? ` (${count})` : ""}:</span>
        {children}
      </div>
    </div>
  );
}
