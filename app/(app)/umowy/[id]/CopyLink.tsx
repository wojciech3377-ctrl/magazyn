"use client";

import { useState } from "react";

export function CopyLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex gap-2">
      <input className="input font-mono text-xs" readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label="Link do podpisu" />
      <button type="button" className="btn-secondary whitespace-nowrap" onClick={async () => {
        await navigator.clipboard.writeText(link);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}>{copied ? "Skopiowano" : "Kopiuj"}</button>
    </div>
  );
}
