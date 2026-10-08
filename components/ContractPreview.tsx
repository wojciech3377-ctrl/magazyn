import type { Block } from "@/lib/contracts/purchase";

/** Treść umowy w przeglądarce (te same bloki co w PDF), z podpisami, jeśli są. */
export function ContractPreview({ blocks, buyerSignature, sellerSignature }: { blocks: Block[]; buyerSignature?: string | null; sellerSignature?: string | null }) {
  return (
    <div className="space-y-1 text-[13px] leading-relaxed text-ink">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "date":
            return <p key={i} className="text-right">{b.text}<br /><span className="text-muted">{b.note}</span>{b.extra && <><br />{b.extra}</>}</p>;
          case "title":
            return <h2 key={i} className="py-3 text-center text-base font-bold">{b.text}</h2>;
          case "section":
            return <p key={i} className="pt-3 text-center font-bold">{b.text}</p>;
          case "p":
            return (
              <p key={i} style={{ marginTop: b.gap ? b.gap * 2 : 0 }}>
                {b.runs.map((r, j) => (r.bold ? <b key={j}>{r.text}</b> : <span key={j}>{r.text}</span>))}
              </p>
            );
          case "signatures":
            return (
              <div key={i} className="grid grid-cols-2 gap-6 pt-6">
                {[[buyerSignature, b.buyer], [sellerSignature, b.seller]].map(([sig, label]) => (
                  <div key={label} className="text-center">
                    <div className="flex h-16 items-end justify-center border-b border-line">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {sig ? <img src={sig} alt={`Podpis: ${label}`} className="max-h-16 max-w-full object-contain" /> : null}
                    </div>
                    <div className="pt-1 font-bold">{label}</div>
                  </div>
                ))}
              </div>
            );
          case "footer":
            return <p key={i} className="pt-4 text-[11px] text-muted">{b.text}</p>;
        }
      })}
    </div>
  );
}
