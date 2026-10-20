import { paymentText } from "@/lib/contracts/options";
import { searchWords, wordsOr } from "@/lib/search";
import Link from "next/link";
import { FilterField, ListToolbar } from "@/components/ListToolbar";
import { activeFilters, filterChips } from "@/lib/list-params";
import { requireProfile } from "@/lib/auth";
import { CONTRACT_TYPE, dateOnly, money } from "@/lib/labels";
import { Notice, PageHeader, Pagination, Pill } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { deleteContract, markPaid } from "./actions";
import { ConfirmSubmit } from "@/components/ConfirmSubmit";

const PER_PAGE = 100;

const CONTRACT_SORTS: Record<string, { label: string; column: string; asc: boolean }> = {
  najnowsze: { label: "Najnowsze", column: "created_at", asc: false },
  najstarsze: { label: "Najstarsze", column: "created_at", asc: true },
  data: { label: "Data umowy", column: "contract_date", asc: false },
  osoba: { label: "Osoba A–Z", column: "counterparty", asc: true },
  kwota: { label: "Kwota: najwyższa", column: "amount", asc: false },
};

const TABS = [
  { key: "", label: "Wszystkie", categories: [] as string[] },
  { key: "accepted", label: "Zaakceptowane – w drodze / do opłaty", categories: ["in_transit", "to_pay"] },
  { key: "done", label: "Gotowe", categories: ["done"] },
  { key: "pending", label: "Oczekujące", categories: ["pending"] },
  { key: "rejected", label: "Odrzucone", categories: ["rejected"] },
  { key: "bez-rzeczy", label: "Bez rzeczy (niewykorzystane)", categories: [] as string[] },
] as const;

type Row = {
  id: string; number: number | null; type: string; counterparty: string; contract_date: string | null; amount: number | null;
  currency: string | null; file_path: string | null; created_at: string; status: string; source: string | null; template: string | null;
  units_created_at: string | null; units_total: number; units_in_transit: number; category: string; paid_at: string | null;
  items: { title: string; option: string; qty?: number }[] | null;
};

function StatePill({ c }: { c: Row }) {
  if (c.status === "sent") return <Pill tone="amber">czeka na podpis</Pill>;
  if (c.status === "offer") return <Pill tone="blue">oferta – czeka na odpowiedź</Pill>;
  if (c.status === "signed") return <Pill tone="red">do zatwierdzenia</Pill>;
  if (c.status === "rejected") return <Pill tone="slate">odrzucona</Pill>;
  if (c.status === "cancelled") return <Pill tone="slate">anulowana</Pill>;
  if (c.category === "done") return <Pill tone="green">{c.template ? "opłacona" : "wgrana"}</Pill>;
  if (c.category === "in_transit") return <Pill tone="blue">w drodze ({c.units_in_transit} szt.)</Pill>;
  if (c.source === "general" && !c.units_created_at) return <Pill tone="blue">do przypisania</Pill>;
  return <Pill tone="amber">do opłaty</Pill>;
}

export default async function UmowyPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { supabase, profile } = await requireProfile();
  const page = Math.max(1, Number(sp.strona ?? 1));
  const tab = TABS.some((t) => t.key === sp.kategoria) ? sp.kategoria ?? "" : "";

  const sort = CONTRACT_SORTS[sp.sort ?? ""] ? sp.sort! : "najnowsze";
  let query = supabase
    .from(sp.kategoria === "bez-rzeczy" ? "contract_overview_unused" : "contract_overview")
    .select("*", { count: "exact" })
    .order(CONTRACT_SORTS[sort].column, { ascending: CONTRACT_SORTS[sort].asc, nullsFirst: false })
    .range((page - 1) * PER_PAGE, page * PER_PAGE - 1);
  const active = TABS.find((t) => t.key === tab)!;
  if (active.categories.length) query = query.in("category", [...active.categories]);
  // „Magazyn umów”: umowy, z którymi żadna rzecz nie jest w magazynie, nie jest sprzedana ani w drodze.
  const { count: unusedCount } = await supabase.from("contracts_unused").select("id", { count: "exact", head: true });
  const qWords = searchWords(sp.q);
  const qex = wordsOr(["counterparty"], qWords, qWords.length === 1 && /^\d+$/.test(qWords[0]) ? [`number.eq.${qWords[0]}`] : []);
  if (qex) query = query.or(qex);
  if (sp.typ) query = query.eq("type", sp.typ);
  if (sp.plik === "brak") query = query.is("file_path", null);
  if (sp.oplacona === "tak") query = query.not("paid_at", "is", null);
  if (sp.oplacona === "nie") query = query.is("paid_at", null);
  const listParams = { kategoria: tab || undefined, q: sp.q, typ: sp.typ, plik: sp.plik, oplacona: sp.oplacona, sort: sp.sort };

  const counts = await Promise.all(
    TABS.map((t) => {
      if (t.key === "bez-rzeczy") return Promise.resolve({ count: unusedCount ?? 0 });
      let q = supabase.from("contract_overview").select("id", { count: "exact", head: true });
      if (t.categories.length) q = q.in("category", [...t.categories]);
      return q;
    }),
  );
  const [{ data, count }, { count: noContract }] = await Promise.all([
    query,
    supabase.from("units").select("id", { count: "exact", head: true }).is("contract_id", null).in("status", ["in_stock", "in_transit", "reserved"]),
  ]);
  const rows = (data ?? []) as Row[];
  // Wgrane skany nie mają pozycji – nazwy produktów bierzemy z przypiętych sztuk.
  const scanIds = rows.filter((r) => !r.items?.length && r.units_total > 0).map((r) => r.id);
  const { data: scanUnits } = scanIds.length
    ? await supabase.from("units").select("contract_id, variant:variants(option, product:products(title))").in("contract_id", scanIds)
    : { data: [] };
  const productsOf = new Map<string, string[]>();
  for (const r of rows) productsOf.set(r.id, (r.items ?? []).map((i) => `${i.title} · ${i.option}${(i.qty ?? 1) > 1 ? ` ×${i.qty}` : ""}`));
  for (const u of scanUnits ?? []) {
    const v = u.variant as unknown as { option: string; product: { title: string } };
    productsOf.get(u.contract_id as string)?.push(`${v.product.title} · ${v.option}`);
  }
  const href = (k: string) => `/umowy${k ? `?kategoria=${k}` : ""}`;
  // Dane sprzedającego (z podpisu) do kolumn i podglądu.
  const { data: extraRows } = rows.length
    ? await supabase.from("contracts").select("id, doc_number, seller_name, seller_address, seller_bank_account, seller_email, seller_phone, payment_method, payment_days, signed_at, accepted_at, notes").in("id", rows.map((r) => r.id))
    : { data: [] };
  type Extra = { doc_number: string | null; seller_name: string | null; seller_address: string | null; seller_bank_account: string | null; seller_email: string | null; seller_phone: string | null; payment_method: string | null; payment_days: number | null; signed_at: string | null; accepted_at: string | null; notes: string | null };
  const extra = new Map((extraRows ?? []).map((e) => [e.id as string, e as unknown as Extra]));
  const nr = (c: Row) => extra.get(c.id)?.doc_number ?? (c.number ? `NR${c.number}` : "–");
  const person = (c: Row) => extra.get(c.id)?.seller_name ?? (c.counterparty === "(czeka na podpis)" ? "–" : c.counterparty);
  const amountText = (c: Row) => (c.currency && c.currency !== "PLN" ? `${Number(c.amount ?? 0).toFixed(2)} ${c.currency}` : money(c.amount));
  const toPay = (c: Row) => c.status === "accepted" && c.template && !c.paid_at && c.source !== "consignor";

  return (
    <>
      <PageHeader
        title="Umowy"
        sub={<Link className="text-accent underline" href="/magazyn?umowa=brak">{noContract} sztuk na stanie bez umowy</Link>}
        actions={
          <>
            <Link className="btn-secondary" href="/umowy/historia">Historia</Link>
            <Link className="btn-secondary" href="/umowy/nowa">Wgraj skan umowy</Link>
            <Link className="btn" href="/umowy/z-szablonu">Umowa z szablonu (link do podpisu)</Link>
          </>
        }
      />

      {sp.ok && <div className="mb-4"><Notice tone="ok">{sp.ok}</Notice></div>}
      {sp.blad && <div className="mb-4"><Notice tone="error">{sp.blad}</Notice></div>}
      <nav className="-mx-4 mb-4 flex gap-1 overflow-x-auto whitespace-nowrap border-b border-line px-4 text-sm sm:mx-0 sm:flex-wrap sm:px-0" aria-label="Kategorie umów">
        {TABS.map((t, i) => (
          <Link
            key={t.key}
            href={href(t.key)}
            className={`-mb-px border-b-2 px-3 py-2 ${tab === t.key ? "border-accent font-medium text-ink" : "border-transparent text-muted hover:text-ink"}`}
          >
            {t.label} <span className="ml-1 rounded bg-panel px-1.5 py-0.5 text-xs tabular-nums">{counts[i].count ?? 0}</span>
          </Link>
        ))}
      </nav>

      <ListToolbar
        q={sp.q}
        placeholder="Osoba lub firma"
        hidden={{ kategoria: tab || undefined }}
        sort={{ value: sort, options: Object.entries(CONTRACT_SORTS).map(([value, o]) => ({ value, label: o.label })) }}
        dirParam={null}
        active={activeFilters(sp, ["typ", "plik", "oplacona"])}
        resetHref={href(tab)}
        chips={filterChips("/umowy", listParams, {
          q: (v) => `„${v}”`,
          typ: (v) => CONTRACT_TYPE[v],
          plik: () => "bez pliku",
          oplacona: (v) => (v === "tak" ? "opłacone" : "nieopłacone"),
        })}
      >
        <FilterField label="Typ umowy">
          <select className="input" name="typ" defaultValue={sp.typ ?? ""}>
            <option value="">Wszystkie typy</option>
            {Object.entries(CONTRACT_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </FilterField>
        <FilterField label="Plik umowy">
          <select className="input" name="plik" defaultValue={sp.plik ?? ""}>
            <option value="">Z plikiem i bez</option>
            <option value="brak">Bez pliku</option>
          </select>
        </FilterField>
        <FilterField label="Opłacona">
          <select className="input" name="oplacona" defaultValue={sp.oplacona ?? ""}>
            <option value="">Wszystkie</option>
            <option value="tak">Opłacone</option>
            <option value="nie">Nieopłacone</option>
          </select>
        </FilterField>
      </ListToolbar>

      <Pagination page={page} total={count ?? 0} perPage={PER_PAGE} params={listParams} top />
      <div className="card overflow-x-auto lg:overflow-visible">
        <table className="table mtable mtable-flow [&_td]:px-2 [&_th]:px-2">
          <thead>
            <tr>
              <th>Numer</th><th>Imię i nazwisko</th><th>Stan</th>{profile.can_see_prices && <th className="text-right">Do opłaty</th>}<th>Konto</th><th>Opłacone</th>
              <th>Typ</th><th>Data</th>{profile.can_see_prices && <th className="text-right">Kwota</th>}<th>Przedmiot</th><th>Adres</th><th />
            </tr>
          </thead>
          <tbody>
            {!rows.length && <tr><td colSpan={12} className="py-10 text-center text-muted">Brak umów w tej kategorii.</td></tr>}
            {rows.map((c) => {
              const e = extra.get(c.id);
              return (
                <tr key={c.id} className="group relative hover:bg-sky-50">
                  <td className="whitespace-nowrap font-medium">
                    <Link className="text-accent after:absolute after:inset-0 after:content-[''] hover:underline" href={`/umowy/${c.id}`}>{nr(c)}</Link>
                    <ContractPreview c={c} e={e} nr={nr(c)} person={person(c)} amount={profile.can_see_prices ? amountText(c) : null} products={productsOf.get(c.id) ?? []} />
                  </td>
                  <td className="min-w-32 max-md:font-medium">{person(c)}</td>
                  <td><StatePill c={c} /></td>
                  {profile.can_see_prices && <td className="whitespace-nowrap text-right tabular-nums">{toPay(c) ? <b>{amountText(c)}</b> : "–"}</td>}
                  <td className="max-w-40 break-all text-xs max-md:hidden">{e?.payment_method === "cash" ? "gotówka" : e?.seller_bank_account ? e.seller_bank_account : e?.payment_method === "transfer" ? <span className="text-warn">przelew – brak konta</span> : "–"}</td>
                  <td className="whitespace-nowrap">
                    {c.paid_at ? <span className="text-sm text-ok">tak · {dateOnly(c.paid_at)}</span> : toPay(c) ? (
                      <form action={markPaid} className="relative z-10">
                        <input type="hidden" name="id" value={c.id} />
                        <input type="hidden" name="back" value={href(tab)} />
                        <SubmitButton className="btn-secondary px-2.5 py-1 text-xs" pendingText="…">Oznacz: opłacona</SubmitButton>
                      </form>
                    ) : <span className="text-sm text-muted">{c.template ? "nie" : "–"}</span>}
                  </td>
                  <td className="text-sm">{CONTRACT_TYPE[c.type]}</td>
                  <td className="whitespace-nowrap text-sm">{dateOnly(c.contract_date ?? c.created_at)}</td>
                  {profile.can_see_prices && <td className="whitespace-nowrap text-right tabular-nums">{amountText(c)}</td>}
                  <td className="m-full max-w-64"><Products names={productsOf.get(c.id) ?? []} /></td>
                  <td className="max-w-48 text-xs text-muted max-md:hidden">{e?.seller_address ?? "–"}</td>
                  <td className="relative z-10 whitespace-nowrap">
                    {tab === "bez-rzeczy" && <Link className="btn-secondary mb-1 inline-block px-2.5 py-1 text-xs" href={`/umowy/${c.id}/przypisz`}>Przypisz</Link>}
                    {c.file_path && <a className="block text-xs text-accent hover:underline" href={`/api/umowy/${c.id}/pdf`} target="_blank" rel="noreferrer">plik</a>}
                    {profile.role === "admin" && (
                      <form action={deleteContract}>
                        <input type="hidden" name="id" value={c.id} />
                        <ConfirmSubmit className="text-xs text-bad hover:underline" message={`Usunąć umowę ${nr(c)}? Rzeczy z tą umową zostaną bez umowy.`}>usuń</ConfirmSubmit>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Pagination page={page} total={count ?? 0} perPage={PER_PAGE} params={listParams} />
    </>
  );
}

/** Nazwy produktów z umowy; przy kilku pozycjach lista zwinięta. */
function Products({ names }: { names: string[] }) {
  if (!names.length) return <span className="text-muted">–</span>;
  if (names.length === 1) return <span className="line-clamp-2 text-sm">{names[0]}</span>;
  return (
    <details className="text-sm">
      <summary className="cursor-pointer"><span className="line-clamp-1 inline">{names[0]}</span> <span className="text-muted">+{names.length - 1}</span></summary>
      <ul className="mt-1 space-y-0.5 text-muted">
        {names.slice(1).map((n, i) => <li key={i}>{n}</li>)}
      </ul>
    </details>
  );
}

/** Podgląd umowy po najechaniu na wiersz (jak w zamówieniach). */
function ContractPreview({ c, e, nr, person, amount, products }: {
  c: Row; e: { seller_address: string | null; seller_bank_account: string | null; seller_email: string | null; seller_phone: string | null; payment_method: string | null; payment_days: number | null; signed_at: string | null; notes: string | null } | undefined;
  nr: string; person: string; amount: string | null; products: string[];
}) {
  return (
    <div role="tooltip" className="pointer-events-none invisible absolute left-20 top-full z-40 mt-1 hidden w-[28rem] rounded-lg border border-line bg-white p-3 text-sm font-normal opacity-0 shadow-xl transition-opacity delay-300 duration-150 group-hover:visible group-hover:opacity-100 lg:block">
      <div className="mb-2 flex items-baseline justify-between gap-2"><b className="text-base">Umowa {nr}</b><StatePill c={c} /></div>
      <div className="grid grid-cols-2 gap-3 text-xs">
        <div>
          <div className="font-medium text-ink">{person}</div>
          {e?.seller_address && <div className="text-muted">{e.seller_address}</div>}
          {e?.seller_phone && <div>{e.seller_phone}</div>}
          {e?.seller_email && <div className="truncate">{e.seller_email}</div>}
        </div>
        <div>
          {amount && <div>Kwota: <b>{amount}</b></div>}
          <div>Zapłata: {paymentText(e?.payment_method, e?.seller_bank_account)}</div>
          {e?.payment_days ? <div className="text-muted">termin: {e.payment_days} dni</div> : null}
          <div>Opłacona: {c.paid_at ? dateOnly(c.paid_at) : "nie"}</div>
          {e?.signed_at && <div className="text-muted">podpisana {dateOnly(e.signed_at)}</div>}
        </div>
      </div>
      {products.length > 0 && <ul className="mt-2 space-y-0.5 border-t border-line pt-2 text-xs">{products.map((p, i) => <li key={i}>{p}</li>)}</ul>}
      {e?.notes && <p className="mt-2 rounded bg-panel p-1.5 text-xs">{e.notes}</p>}
    </div>
  );
}
