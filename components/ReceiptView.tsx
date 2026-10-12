/** Podgląd paragonu fiskalnego (jak wydruk z drukarki): nagłówek firmy, pozycje, PTU, suma. */
export type ReceiptLine = { name: string; qty: number; price: number; rate: number | null };
const LETTER: Record<string, string> = { "23": "A", "8": "B", "5": "C", "0": "D" };
const f2 = (n: number) => n.toFixed(2);

export function ReceiptView({ company, date, number, lines, transaction, title = "PARAGON FISKALNY" }: {
  company: { name: string; street?: string | null; city?: string | null; nip?: string | null };
  date: string; number: string | null; lines: ReceiptLine[]; transaction?: string | null; title?: string;
}) {
  const letter = (r: number | null) => (r === null ? "D" : LETTER[String(r)] ?? "E");
  const groups = new Map<string, { rate: number; gross: number }>();
  for (const l of lines) {
    const k = letter(l.rate);
    const g = groups.get(k) ?? { rate: l.rate ?? 0, gross: 0 };
    g.gross += l.qty * l.price;
    groups.set(k, g);
  }
  const total = lines.reduce((s, l) => s + l.qty * l.price, 0);
  return (
    <div className="mx-auto w-full max-w-md bg-white p-6 font-sans text-[13px] text-black shadow-sm ring-1 ring-line">
      <div className="text-center leading-tight">
        <div>{company.name}</div>
        {company.street && <div>{company.street}</div>}
        {company.city && <div>{company.city}</div>}
        {company.nip && <div>PL{company.nip.replace(/\D/g, "")}</div>}
      </div>
      <div className="mt-3 flex justify-between"><span>{date}</span><span>{number ?? "–"}</span></div>
      <div className="mt-2 text-center"><div className="text-base font-bold">{title}</div><div className="text-[9px] font-semibold text-slate-500">FISCAL RECEIPT</div></div>
      <hr className="my-3 border-slate-300" />
      <div className="space-y-1.5">
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-[1fr_auto_auto] gap-3">
            <span>{l.name}</span>
            <span className="whitespace-nowrap">{l.qty} x {f2(l.price)}=</span>
            <span className="whitespace-nowrap text-right">{f2(l.qty * l.price)} {letter(l.rate)}</span>
          </div>
        ))}
      </div>
      <hr className="my-3 border-slate-300" />
      {[...groups.entries()].map(([k, g]) => {
        const tax = g.rate ? g.gross - g.gross / (1 + g.rate / 100) : 0;
        return (
          <div key={k} className="space-y-0.5">
            <div className="flex justify-between"><span>Sprzedaż opodatkowana {k}</span><span>{f2(g.gross)}</span></div>
            <div className="text-[9px] text-slate-500">Taxable sales</div>
            <div className="flex justify-between"><span>PTU {k} {g.rate}%</span><span>{f2(tax)}</span></div>
            <div className="text-[9px] text-slate-500">Tax</div>
          </div>
        );
      })}
      <div className="mt-2 flex items-end justify-between"><span className="text-2xl font-bold">Suma PLN</span><span className="text-2xl font-bold">{f2(total)}</span></div>
      <div className="text-[9px] text-slate-500">Sum</div>
      {transaction && <div className="mt-3 flex justify-between text-xs"><span>Numer transakcji<span className="block text-[9px] text-slate-500">Transaction number</span></span><span>{transaction}</span></div>}
    </div>
  );
}
