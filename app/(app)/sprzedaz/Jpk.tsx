import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { loadJpkLines, sortBy, type DocKind, type JpkSort } from "@/lib/jpk";
import { attachContractForPiece, deletePosOrder } from "./actions";
import { SubmitButton } from "@/components/SubmitButton";
import { dateOnly, money } from "@/lib/labels";
import { monthLabel, monthRange, previousMonthKey, warsawMidnight } from "@/lib/month";
import { Notice, Pill } from "@/components/ui";
import { SelectAllNamed } from "@/components/SelectAll";
import { ConfirmSubmit } from "@/components/ConfirmSubmit";
import { errorMessage } from "@/lib/errors";
import { KSEF_STATUS } from "@/lib/invoices/labels";
import { isSettled, MISSING_BTN, STAGE_TEXT } from "@/lib/contracts/stage";
import { ConsignorWaiting } from "@/components/ContractBadges";

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
const SORTS: { key: JpkSort; label: string }[] = [
  { key: "data_asc", label: "Data: od najstarszych" },
  { key: "data_desc", label: "Data: od najnowszych" },
  { key: "kwota_desc", label: "Kwota: od najwyższej" },
  { key: "kwota_asc", label: "Kwota: od najniższej" },
];

const isDay = (v: string | undefined): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
const dayStart = (v: string) => { const [y, m, d] = v.split("-").map(Number); return warsawMidnight(y, m, d); };

export async function Jpk({ sp }: { sp: Record<string, string | undefined> }) {
  const { supabase, profile } = await requireProfile();
  // Zakres: dokładne daty (od–do, także jeden dzień) albo cały miesiąc.
  const month = monthRange(sp.miesiac);
  const custom = isDay(sp.od) || isDay(sp.do);
  const fromDay = isDay(sp.od) ? sp.od : isDay(sp.do) ? sp.do : null;
  const toDay = isDay(sp.do) ? sp.do : fromDay;
  const range = custom && fromDay && toDay
    ? { from: dayStart(fromDay), to: new Date(dayStart(toDay).getTime() + 26 * 3600_000), label: fromDay === toDay ? dateOnly(fromDay) : `${dateOnly(fromDay)} – ${dateOnly(toDay)}` }
    : { from: month.from, to: month.to, label: monthLabel(month.key) };
  if (custom && toDay) range.to = dayStart(new Date(new Date(`${toDay}T12:00:00Z`).getTime() + 86400_000).toISOString().slice(0, 10));
  const kind = KINDS.find((k) => k.key === sp.rodzaj)?.key ?? "all";
  const sort = SORTS.find((x) => x.key === sp.sort)?.key ?? "data_asc";
  const preselect = sp.zaznacz === "1";
  let lines: Awaited<ReturnType<typeof loadJpkLines>> = [];
  let error: string | null = null;
  try {
    lines = sortBy(await loadJpkLines(supabase, { from: range.from, to: range.to, kind }), sort);
  } catch (e) {
    error = errorMessage(e);
  }
  const prev = previousMonthKey();
  const total = lines.reduce((s, l) => s + (l.price ?? 0), 0);
  const prices = profile.can_see_prices;
  const qs = new URLSearchParams(Object.entries({ widok: "jpk", miesiac: custom ? undefined : month.key, od: custom ? fromDay ?? undefined : undefined, do: custom ? toDay ?? undefined : undefined, rodzaj: kind, sort }).filter((e): e is [string, string] => !!e[1])).toString();

  return (
    <>
      <form method="get" className="mb-3 flex flex-wrap items-end gap-2">
        <input type="hidden" name="widok" value="jpk" />
        <div>
          <label className="label" htmlFor="miesiac">Miesiąc</label>
          <input id="miesiac" className="input w-40" type="month" name="miesiac" defaultValue={custom ? "" : month.key} />
        </div>
        <span className="pb-2 text-sm text-muted">albo</span>
        <div>
          <label className="label" htmlFor="od">Od dnia</label>
          <input id="od" className="input w-40" type="date" name="od" defaultValue={custom ? fromDay ?? "" : ""} />
        </div>
        <div>
          <label className="label" htmlFor="do">Do dnia</label>
          <input id="do" className="input w-40" type="date" name="do" defaultValue={custom ? toDay ?? "" : ""} />
        </div>
        <div>
          <label className="label" htmlFor="rodzaj">Dokument</label>
          <select id="rodzaj" className="input w-44" name="rodzaj" defaultValue={kind}>
            {KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="sort">Sortuj</label>
          <select id="sort" className="input w-52" name="sort" defaultValue={sort}>
            {SORTS.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
          </select>
        </div>
        <button className="btn-secondary">Pokaż</button>
      </form>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Link className="btn-secondary" href={`/sprzedaz?widok=jpk&miesiac=${prev}&rodzaj=${kind === "none" ? "all" : kind}&sort=${sort}&zaznacz=1`}>Zaznacz z ostatniego miesiąca</Link>
        <form action="/api/jpk" method="post">
          <input type="hidden" name="miesiac" value={prev} />
          <button className="btn-secondary" name="eksport" value="umowy">Pobierz umowy z ostatniego miesiąca</button>
        </form>
        <span className="text-xs text-muted sm:ml-auto">Paragony z drukarki fiskalnej i faktury wysłane do KSeF.</span>
      </div>
      {error && <div className="mb-4"><Notice tone="error">{error}</Notice></div>}
      {kind === "none" && <div className="mb-4"><Notice>Sprzedaże ({range.label}), do których nie ma jeszcze paragonu ani faktury.</Notice></div>}

      {/* „Dołącz umowę” w wierszach: przyciski z atrybutem form wysyłają ten formularz. */}
      <form id="jpk-umowa" action={attachContractForPiece}><input type="hidden" name="back" value={`/sprzedaz?${qs}`} /></form>
      <form id="jpk" action="/api/jpk" method="post">
        <input type="hidden" name="okres" value={custom ? `${fromDay}_${toDay}` : month.key} />
        <input type="hidden" name="back" value={`/sprzedaz?${qs}`} />
        <div className="sticky top-14 z-20 lg:top-0 mb-2 flex flex-wrap items-center gap-3 border-b border-line bg-white/95 py-2 text-sm backdrop-blur">
          <label className="flex items-center gap-2"><SelectAllNamed name="l" /> zaznacz wszystkie ({lines.length})</label>
          <span className="text-muted">{range.label} · razem {money(total)}</span>
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
              {!lines.length && <tr><td colSpan={11} className="py-10 text-center text-muted">Brak sprzedaży w tym okresie.</td></tr>}
              {lines.map((l) => {
                const foreign = l.currency && l.currency !== "PLN";
                const red = !!l.saleNote;
                return (
                  <tr key={l.key} className={red ? "bg-rose-50" : foreign ? "bg-yellow-50" : ""}>
                    <td><input type="checkbox" name="l" value={l.key} defaultChecked={preselect} className="h-4 w-4" aria-label={`Zaznacz ${l.name}`} /></td>
                    <td className="whitespace-nowrap">
                      {l.kind ? <><Pill tone={l.kind === "invoice" ? "blue" : "slate"}>{l.kind === "invoice" ? "FV" : "paragon"}</Pill> <span className="font-mono text-xs">{l.docNumber}</span></> : <span className="text-xs text-warn">bez dokumentu</span>}
                    </td>
                    <td className="whitespace-nowrap text-muted">{dateOnly(l.docDate ?? l.saleDate)}</td>
                    <td>{l.name}{l.unitCode && <span className="ml-1 font-mono text-xs text-muted">{l.unitCode}</span>}</td>
                    <td className="text-right tabular-nums">{money(l.price)}</td>
                    <td className="font-medium">{l.vat}</td>
                    <td className="whitespace-nowrap text-muted">{dateOnly(l.contractDate)}</td>
                    {prices && <td className="text-right tabular-nums">{l.purchasePrice !== null ? `${l.purchasePrice.toFixed(2)}${foreign ? ` ${l.currency}` : ""}` : "–"}</td>}
                    <td className="whitespace-nowrap">
                      {l.contractId && l.contractStage && !isSettled(l.contractStage) && l.contractStage !== "dead"
                        ? <Link className="rounded border border-orange-300 bg-orange-50 px-1.5 py-0.5 text-xs text-orange-800 hover:underline" href={`/umowy/${l.contractId}`}>umowa w toku · {STAGE_TEXT[l.contractStage]}</Link>
                        : l.contractId ? <Link className="rounded border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 text-emerald-800 hover:underline" href={`/umowy/${l.contractId}`}>{l.contractNumber ?? "bez numeru"} ✓</Link>
                        : l.pendingContractId ? <Link className="rounded border border-orange-300 bg-orange-50 px-1.5 py-0.5 text-xs text-orange-800 hover:underline" href={`/umowy/${l.pendingContractId}`}>umowa w toku</Link>
                        : l.consignorWait ? <ConsignorWaiting />
                        : l.unitId ? <Link className={MISSING_BTN} href={`/sprzedaz/umowa?sztuka=${l.unitId}&back=${encodeURIComponent(`/sprzedaz?${qs}`)}`}>Dołącz umowę</Link>
                        : l.pieceRef && !l.saleNote ? <button form="jpk-umowa" name="umowa_dla" value={l.pieceRef} className={MISSING_BTN} title={l.variantLinked ? undefined : "Produkt nie jest powiązany z katalogiem – wybierzesz go przy umowie"}>Dołącz umowę</button>
                        : <span className="text-muted">–</span>}
                    </td>
                    <td className="whitespace-nowrap text-xs">
                      {l.saleNote && <span className="font-semibold text-bad">{l.saleNote} </span>}
                      {foreign && <span className="font-medium">{l.currency === "EUR" ? "EURO" : l.currency}</span>}
                    </td>
                    <td className="whitespace-nowrap text-xs">
                      {l.orderHref ? <Link className="text-accent hover:underline" href={l.orderHref}>{l.orderLabel}</Link> : l.orderLabel}
                      {profile.role === "admin" && l.source === "pos" && l.orderHref?.startsWith("/kasa/") && (
                        <ConfirmSubmit formAction={deletePosOrder} name="id" value={l.orderHref.slice(6)} className="ml-2 text-bad hover:underline"
                          message={`Usunąć sprzedaż stacjonarną ${l.orderLabel}? Sztuki wrócą na stan, a sprzedaż zniknie z JPK.`}>usuń</ConfirmSubmit>
                      )}
                    </td>
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

/** Zakładka Faktury: lista faktur (FVM/n/rok) ze statusem KSeF. */
export async function Invoices({ sp }: { sp: Record<string, string | undefined> }) {
  const { supabase } = await requireProfile();
  const status = sp.ksef ?? "";
  let q = supabase.from("invoices").select("id, number, issue_date, buyer, total_gross, status, ksef_number, kind, order:orders(id, name), pos:pos_orders(id, code)")
    .order("issue_date", { ascending: false }).order("created_at", { ascending: false }).limit(300);
  if (status === "paragon") q = q.eq("kind", "receipt");
  else if (status) q = q.eq("status", status).neq("kind", "receipt");
  const { data: rows } = await q;
  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <form method="get" className="flex gap-2">
          <input type="hidden" name="widok" value="faktury" />
          <select className="input w-56" name="ksef" defaultValue={status} aria-label="Status KSeF">
            <option value="">Wszystkie</option>
            {Object.entries(KSEF_STATUS).map(([k, v]) => <option key={k} value={k}>{v.text}</option>)}
            <option value="paragon">Paragony (PAR)</option>
          </select>
          <button className="btn-secondary">Pokaż</button>
        </form>
        <Link className="btn ml-auto" href="/sprzedaz/faktury/nowa">Nowa faktura / paragon</Link>
      </div>
      <div className="card overflow-x-auto">
        <table className="table">
          <thead><tr><th>Numer</th><th>Data</th><th>Nabywca</th><th className="text-right">Kwota</th><th>KSeF</th><th>Sprzedaż</th></tr></thead>
          <tbody>
            {!rows?.length && <tr><td colSpan={6} className="py-10 text-center text-muted">Brak faktur. Fakturę wystawisz z zamówienia, ze sprzedaży stacjonarnej albo przyciskiem „Nowa faktura”.</td></tr>}
            {rows?.map((r) => {
              const st = KSEF_STATUS[r.status] ?? KSEF_STATUS.issued;
              const order = r.order as unknown as { id: string; name: string } | null;
              const pos = r.pos as unknown as { id: string; code: string } | null;
              return (
                <tr key={r.id} className="relative hover:bg-sky-50">
                  <td><Link className="font-medium text-accent after:absolute after:inset-0 after:content-[''] hover:underline" href={`/sprzedaz/faktury/${r.id}`}>{r.number}</Link></td>
                  <td className="whitespace-nowrap text-muted">{dateOnly(r.issue_date)}</td>
                  <td>{(r.buyer as { name: string }).name}</td>
                  <td className="text-right tabular-nums">{money(r.total_gross)}</td>
                  <td>{r.kind === "receipt" ? <Pill tone="slate">paragon – poza KSeF</Pill> : <><Pill tone={st.tone}>{st.text}</Pill>{r.ksef_number && <span className="block font-mono text-xs text-muted">{r.ksef_number}</span>}</>}</td>
                  <td className="text-xs">{order ? <Link className="relative z-10 text-accent hover:underline" href={`/sprzedaz/${order.id}`}>{order.name}</Link> : pos ? <Link className="relative z-10 text-accent hover:underline" href={`/kasa/${pos.id}`}>{pos.code}</Link> : "–"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
