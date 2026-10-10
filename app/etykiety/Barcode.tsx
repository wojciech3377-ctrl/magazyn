"use client";

import { useEffect, useRef } from "react";
import JsBarcode from "jsbarcode";

export function Barcode({ value, className = "h-[9mm] w-full" }: { value: string; className?: string }) {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (ref.current) JsBarcode(ref.current, value, { format: "CODE128", height: 34, width: 1.6, margin: 0, displayValue: false });
  }, [value]);
  return <svg ref={ref} className={className} preserveAspectRatio="none" />;
}

export function PrintButton() {
  return (
    <button className="btn" onClick={() => window.print()}>Drukuj</button>
  );
}
