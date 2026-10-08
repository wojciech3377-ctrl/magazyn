import type { Block } from "@/lib/contracts/purchase";

/** Treść umowy w przeglądarce (te same bloki co w PDF). */
export function ContractPreview({ blocks }: { blocks: Block[] }) {
  return (
    <div className="space-y-1 text-[13px] leading-relaxed text-ink">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "date":
            return <p key={i} className="text-right">{b.text}<br /><span className="text-muted">{b.note}</span></p>;
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
            return null;
          case "footer":
            return <p key={i} className="pt-4 text-[11px] text-muted">{b.text}</p>;
        }
      })}
    </div>
  );
}
