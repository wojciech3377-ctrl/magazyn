"use client";

import { useEffect, useRef, useState } from "react";

/** Podpis palcem lub myszką. Wynik (PNG, data URL) trafia do ukrytego pola formularza. */
export function SignaturePad({ name = "signature", label = "Podpis", onChange }: { name?: string; label?: string; onChange?: (v: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [value, setValue] = useState("");

  useEffect(() => {
    const canvas = canvasRef.current!;
    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      const { width, height } = canvas.getBoundingClientRect();
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      const ctx = canvas.getContext("2d")!;
      ctx.scale(ratio, ratio);
      ctx.lineWidth = 2.2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = "#0b1b3f";
      setValue("");
      onChange?.("");
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const point = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const finish = () => {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    const v = canvasRef.current!.toDataURL("image/png");
    setValue(v);
    onChange?.(v);
  };

  const clear = () => {
    const c = canvasRef.current!;
    c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
    setValue("");
    onChange?.("");
  };

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="label mb-0">{label}</span>
        <button type="button" onClick={clear} className="text-xs text-muted underline">Wyczyść</button>
      </div>
      <canvas
        ref={canvasRef}
        className="h-40 w-full touch-none rounded-md border border-dashed border-line bg-white"
        aria-label={label}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drawing.current = true;
          last.current = point(e);
        }}
        onPointerMove={(e) => {
          if (!drawing.current || !last.current) return;
          const ctx = canvasRef.current!.getContext("2d")!;
          const p = point(e);
          ctx.beginPath();
          ctx.moveTo(last.current.x, last.current.y);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
          last.current = p;
        }}
        onPointerUp={finish}
        onPointerLeave={finish}
      />
      <input type="hidden" name={name} value={value} />
      {!value && <p className="mt-1 text-xs text-muted">Podpisz się palcem albo myszką w ramce.</p>}
    </div>
  );
}
