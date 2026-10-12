"use client";

import { useEffect } from "react";

/**
 * Telefon: tabele `.mtable-flow` pokazują wiersze jako karty – nad wartością komórki podpis z nagłówka kolumny
 * (data-label). Uzupełnia podpisy po każdej zmianie strony (także po nawigacji i odświeżeniu danych).
 */
export function TableLabels() {
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const label = () => {
      for (const table of document.querySelectorAll<HTMLTableElement>("table.mtable-flow")) {
        const heads: string[] = [];
        for (const th of table.querySelectorAll<HTMLTableCellElement>("thead tr:first-child th")) {
          const text = (th.textContent ?? "").replace(/[↕▲▼]/g, "").trim();
          for (let i = 0; i < (th.colSpan || 1); i++) heads.push(text);
        }
        if (!heads.length) continue;
        for (const tr of table.querySelectorAll<HTMLTableRowElement>("tbody tr")) {
          let col = 0;
          for (const td of Array.from(tr.cells)) {
            const h = heads[col];
            if (h && !td.hasAttribute("data-label") && td.colSpan === 1) td.setAttribute("data-label", h);
            col += td.colSpan || 1;
          }
        }
      }
    };
    // Dopiero po pełnym wczytaniu i hydratacji (podpisy dodane wcześniej React uznałby za niezgodność z serwerem).
    const obs = new MutationObserver(() => { if (t) clearTimeout(t); t = setTimeout(label, 120); });
    let start: ReturnType<typeof setTimeout> | null = null;
    const begin = () => { start = setTimeout(() => { label(); obs.observe(document.body, { childList: true, subtree: true }); }, 900); };
    if (document.readyState === "complete") begin();
    else window.addEventListener("load", begin, { once: true });
    return () => { window.removeEventListener("load", begin); obs.disconnect(); if (t) clearTimeout(t); if (start) clearTimeout(start); };
  }, []);
  return null;
}
