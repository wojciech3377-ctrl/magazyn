"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Poziomy pasek przewijania dla szerokiej tabeli, przyklejony w widocznym miejscu (np. nad „Zaznaczone:”).
 * Działa razem z przewijaniem samej tabeli – oba zawsze w tym samym miejscu. Widoczny tylko, gdy tabela się nie mieści.
 */
export function HScrollBar({ target, className = "" }: { target: string; className?: string }) {
  const bar = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [show, setShow] = useState(false);

  useEffect(() => {
    const el = document.getElementById(target);
    const b = bar.current;
    if (!el || !b || !inner.current) return;
    const measure = () => {
      inner.current!.style.width = `${el.scrollWidth}px`;
      b.style.width = `${el.clientWidth}px`;
      setShow(el.scrollWidth > el.clientWidth + 2);
      b.scrollLeft = el.scrollLeft;
    };
    const fromTable = () => { if (Math.abs(b.scrollLeft - el.scrollLeft) > 1) b.scrollLeft = el.scrollLeft; };
    const fromBar = () => { if (Math.abs(el.scrollLeft - b.scrollLeft) > 1) el.scrollLeft = b.scrollLeft; };
    measure();
    el.addEventListener("scroll", fromTable, { passive: true });
    b.addEventListener("scroll", fromBar, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    window.addEventListener("resize", measure);
    return () => {
      el.removeEventListener("scroll", fromTable);
      b.removeEventListener("scroll", fromBar);
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [target]);

  return (
    <div ref={bar} className={`hscroll overflow-x-auto overflow-y-hidden ${show ? "" : "hidden"} ${className}`} aria-hidden="true" title="Przewiń tabelę w bok">
      <div ref={inner} className="h-px" />
    </div>
  );
}
