import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { loadJpkLines, type DocKind } from "@/lib/jpk";
import { dateOnly, money } from "@/lib/labels";
import { monthLabel, monthRange, previousMonthKey } from "@/lib/month";
import { Notice, Pill } from "@/components/ui";
import { SelectAllNamed } from "@/components/SelectAll";
import { errorMessage } from "@/lib/errors";

const KINDS: { key: "all" | DocKind | "none"; label: string }[] = [
  { key: "all", label: "Paragony i faktury" },
  { key: "receipt", label: "Paragony" },
  { key: "invoice", label: "Faktury" },
  { key: "none", label: "Bez dokumentu" },
];

/**
 * JPK: wszystkie sprzedaże (sklep + stacjonarna, a z modułem faktur także faktury) według daty
 * paragonu / faktury, z danymi zakupu z umowy. Zaznaczone → Excel JPK albo ZIP z umowami.
 */
export async function Jpk({ sp }: { sp: Record<string, string | undefined> }) {
  const { supabase, profile } = await requireProfile();
  const range = monthRange(sp.miesiac);
  const kind = KINDS.find((k) => k.key === sp.rodzaj)?.key ?? "all";
  const preselect = sp.zaznacz === "1";
  let lines: Awaited<ReturnType<typeof loadJpkLines>> = [];
  let error: string | null = null;
  try {
    lines = await loadJpkLines(supabase, { from: range.from, to: range.to, kind });
  } catch (e) {
    error = errorMessage(e);
  }
  const prev = previousMonthKey();
  const total = lines.reduce((s, l) => s + (l.price ?? 0), 0);
  const prices = profile.can_see_prices;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <form method="get" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="widok" value="jpk" />
          <div>
            <label className="label" htmlFor="miesiac">Miesiąc dokumentu</label>
            <input id="miesiac" className="input w-44" type="month" name="miesiac" defaultValue={range.key} />
          </div>
          <div>
            <label className="label" htmlFor="rodzaj">Dokument</label>
            <select id="rodzaj" className="input w-48" name="rodzaj" defaultValue={kind}>
              {KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
            </select>
          </div>
          <button className="btn-secondary">Pokaż</button>
        </form>
        <div className="flex flex-wrap gap-2 sm:ml-auto">
          <Link className="btn-secondary" href={`/sprzedaz?widok=jpk&miesiac=${prev}&rodzaj=${kind === "none" ? "all" : kind}&zaznacz=1`}>Zaznacz z ostatniego miesiąca</Link>
          <form action="/api/jpk" method="post">
            <input type="hidden" name="miesiac" value={prev} />
            <button className="btn-secondary" name="eksport" value="umowy">Pobierz umowy z ostatniego miesiąca</button>
          </form>
        </div>
      </div>

      {error && <div className="mb-4"><Notice tone="error">{error}</Notice></div>}
      {kind === "invoice" && <div className="mb-4"><Notice>Faktury pojawią się tu po uruchomieniu modułu faktur (zakładka Faktury).</Notice></div>}
      {kind === "none" && <div className="mb-4"><Notice>Sprzedaże z {monthLabel(range.key)} bez paragonu ani faktury – nie trafią do JPK, dopóki nie dostaną dokumentu.</Notice></div>}

      <form id="jpk" action="/api/jpk" method="post">
        <input type="hidden" name="okres" value={range.key} />
        <div className="sticky top-0 z-20 mb-2 flex flex-wrap items-center gap-3 border-b border-line bg-white/95 py-2 text-sm backdrop-blur">
          <label className="flex items-center gap-2"><SelectAllNamed name="l" /> zaznacz wszystkie ({lines.length})</label>
          <span className="text-muted">{monthLabel(range.key)} · razem {money(total)}</span>
          <div className="ml-auto flex flex-wrap gap-2">
            <button className="btn-secondary px-3 py-1.5 text-sm" name="eksport" value="umowy">Pobierz umowy zaznaczonych (ZIP)</button>
            {prices && <button className="btn px-3 py-1.5 text-sm" name="eksport" value="xlsx">Utwórz plik JPK (Excel)</button>}
          </div>
        </div>
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th className="w-8" /><th>Dokument</th><th>Data</th><th>Nazwa przedmiotu</th><th className="text-right">Kwota</th><th>VAT</th>
                <th>Data zakupu</th>{prices && <th className="text-right">Kwota zakupu</th>}<th>Numer umowy</th><th>Uwagi</th><th>Sprzedaż</th>
              </tr>
            </thead>
            <tbody>
              {!lines.length && <tr><td colSpan={11} className="py-10 text-center text-muted">Brak sprzedaży w tym miesiącu.</td></tr>}
              {lines.map((l) => {
                const foreign = l.currency && l.currency !== "PLN";
                const red = l.saleNote === "ZWROT" || l.saleNote === "NIE ODEBRANE POBRANIE";
                return (
                  <tr key={l.key} className={red ? "bg-rose-50" : foreign ? "bg-yellow-50" : ""}>
                    <td><input type="checkbox" name="l" value={l.key} defaultChecked={preselect} className="h-4 w-4" aria-label={`Zaznacz ${l.name}`} /></td>
                    <td className="whitespace-nowrap">
                      {l.kind ? <><Pill tone={l.kind === "invoice" ? "blue" : "slate"}>{l.kind === "invoice" ? "FV" : "paragon"}</Pill> <span className="font-mono text-xs">{l.docNumber}</span></> : <span className="text-xs text-warn">brak dokumentu</span>}
                    </td>
                    <td className="whitespace-nowrap text-muted">{dateOnly(l.docDate ?? l.saleDate)}</td>
                    <td>{l.name}{l.unitCode && <span className="ml-1 font-mono text-xs text-muted">{l.unitCode}</span>}</td>
                    <td className="text-right tabular-nums">{money(l.price)}</td>
                    <td className="font-medium">{l.vat}</td>
                    <td className="whitespace-nowrap text-muted">{dateOnly(l.contractDate)}</td>
                    {prices && <td className="text-right tabular-nums">{l.purchasePrice !== null ? `${l.purchasePrice.toFixed(2)}${foreign ? ` ${l.currency}` : ""}` : "–"}</td>}
                    <td className="whitespace-nowrap">
                      {l.contractId ? <Link className="text-accent hover:underline" href={`/umowy/${l.contractId}`}>{l.contractNumber ?? "bez numeru"}</Link>
                        : l.unitId ? <Link className="text-xs text-warn hover:underline" href={`/umowy/z-szablonu?ids=${l.unitId}`}>brak umowy</Link> : <span className="text-muted">–</span>}
                    </td>
                    <td className="whitespace-nowrap text-xs">
                      {l.saleNote && <span className="font-semibold text-bad">{l.saleNote} </span>}
                      {foreign && <span className="font-medium">{l.currency === "EUR" ? "EURO" : l.currency}</span>}
                    </td>
                    <td className="whitespace-nowrap text-xs">{l.orderHref ? <Link className="text-accent hover:underline" href={l.orderHref}>{l.orderLabel}</Link> : l.orderLabel}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </form>
    </>
  );
}

/** Zakładka Faktury – moduł w przygotowaniu (wystawianie FV + wysyłka do KSeF). */
export function Invoices() {
  return (
    <div className="card p-6">
      <h2 className="h2 mb-2">Faktury</h2>
      <p className="text-sm text-muted">
        Tu będzie wystawianie faktur do zamówień i sprzedaży stacjonarnej oraz ich wysyłka do KSeF. Wystawione faktury trafią automatycznie do JPK (arkusz „Faktury”).
      </p>
    </div>
  );
}
