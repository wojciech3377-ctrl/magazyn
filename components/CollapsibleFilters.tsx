"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/icons";

/**
 * Filtry zwijane: na komputerze (mysz, szeroki ekran) od razu rozwinięte, na tablecie / ekranie dotykowym kasy
 * zwinięte do jednego przycisku z podsumowaniem – nie zabierają miejsca.
 */
export function CollapsibleFilters({ summary, children }: { summary: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (window.matchMedia("(pointer: coarse), (max-width: 1279.98px)").matches) setOpen(false);
  }, []);
  return (
    <div className="mb-3">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className={`btn-secondary mb-2 ${open ? "border-accent/50 text-accent" : ""}`}>
        <Icon name="filter" className="h-4 w-4" /> Filtry <span className="font-normal text-muted">· {summary}</span>
        <Icon name="chevron" className={`h-3.5 w-3.5 transition-transform ${open ? "-rotate-90" : "rotate-90"}`} />
      </button>
      {open && children}
    </div>
  );
}
