"use client";

import { useEffect } from "react";

/** Systemowe okno drukowania od razu po otwarciu listy. */
export function AutoPrint() {
  useEffect(() => {
    const t = setTimeout(() => window.print(), 300);
    return () => clearTimeout(t);
  }, []);
  return null;
}
