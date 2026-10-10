import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { queryUnits, UNIT_SORTS, type UnitFilters, type UnitRow } from "@/lib/queries/units";
import { money, dateOnly, OWNER_TYPE, PURCHASE_FORM, UNIT_STATUS } from "@/lib/labels";
import { Notice, PageHeader, Pagination, Pill, StatusBadge, Thumb } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { ConfirmSubmit } from "@/components/ConfirmSubmit";
import { SelectAll } from "@/components/SelectAll";
import { bulkAction, runAutoCatalogNow } from "./actions";

const PER_PAGE = 100;

/** Cena w sklepie, z którego jest lokalizacja sztuki (albo z dowolnego sklepu). */
function shopPrice(u: UnitRow) {
  return u.variant.links.find((l) => l.store_id === u.location.store_id && l.price !== null)?.price
    ?? u.variant.links.find((l) => l.price !== null)?.price
    ?? null;
}

export default async function MagazynPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { supabase, profile } = await requireProfile();
  const page = Math.max(1, Number(sp.strona ?? 1));
  const filters: UnitFilters = {
    q: sp.q, sklep: sp.sklep, lokalizacja: sp.lokalizacja, status: sp.status, umowa: sp.umowa, wlasciciel: sp.wlasciciel, komisant: sp.komisant,
    forma: sp.forma, rozmiar: sp.rozmiar, cena_od: sp.cena_od, cena_do: sp.cena_do, zakup_od: sp.zakup_od, zakup_do: sp.zakup_do,
    od: sp.od, do: sp.do, imei: sp.imei, sort: sp.sort, kier: sp.kier,
  };
  const more = ["komisant", "forma", "rozmiar", "cena_od", "cena_do", "zakup_od", "zakup_do", "od", "do", "imei"].some((k) => sp[k]);

  const [{ rows, count }, { data: stores }, { data: locations }, { data: contracts }, { count: noContract }, { data: consignors }] = await Promise.all([
    queryUnits(supabase, filters, [(page - 1) * PER_PAGE, page * PER_PAGE - 1]),
    supabase.from("stores").select("id, name").order("name"),
    supabase.from("locations").select("id, name, store_id").eq("active", true).order("name"),
    supabase.from("contracts").select("id, type, counterparty, contract_date").order("created_at", { ascending: false }).limit(200),
    supabase.from("units").select("id", { count: "exact", head: true }).is("contract_id", null).in("status", ["in_stock", "in_transit", "reserved"]),
    supabase.from("consignors").select("id, name").order("name"),
  ]);

  const filterParams = Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) as Record<string, string>;
  const qs = new URLSearchParams(filterParams).toString();
  const returnTo = `/magazyn${qs ? `?${qs}` : ""}`;
  const storeName = new Map((stores ?? []).map((s) => [s.id, s.name]));
  const activeSort = UNIT_SORTS[sp.sort ?? ""] ? sp.sort! : "przyjeta";
  const activeAsc = sp.kier === "asc" ? true : sp.kier === "desc" ? false : UNIT_SORTS[activeSort].asc;
  /** Nagłówek kolumny: klik sortuje, drugi klik odwraca kierunek. */
  const SortTh = ({ k, children, right }: { k: string; children: React.ReactNode; right?: boolean }) => {
    const on = activeSort === k;
    const params = new URLSearchParams({ ...filterParams, sort: k, kier: on ? (activeAsc ? "desc" : "asc") : (UNIT_SORTS[k].asc ? "asc" : "desc") });
    params.delete("strona");
    return (
      <th className={right ? "text-right" : ""} aria-sort={on ? (activeAsc ? "ascending" : "descending") : undefined}>
        <Link href={`/magazyn?${params}`} className={`inline-flex items-center gap-1 hover:text-ink ${on ? "text-ink" : ""}`}>
          {children}<span className="text-[10px]">{on ? (activeAsc ? "▲" : "▼") : "↕"}</span>
        </Link>
      </th>
    );
  };

  return (
    <>
      <PageHeader
        title="Magazyn"
        sub={<>{count} szt. w widoku{noContract ? <> · <Link className="text-accent underline" href="/magazyn?umowa=brak">{noContract} na stanie bez umowy</Link></> : null}</>}
        actions={
          <>
            {profile.role === "admin" && <form action={runAutoCatalogNow}><SubmitButton className="btn-secondary" pendingText="Sprawdzam…">Sprawdź nowe produkty i stany</SubmitButton></form>}
            <Link className="btn-secondary" href={`/api/eksport/sztuki${qs ? `?${qs}` : ""}`}>Eksport CSV</Link>
            <Link className="btn" href="/dostawa">Przyjmij dostawę</Link>
          </>
        }
      />

      {sp.ok && <div className="mb-4"><Notice tone="ok">{sp.ok}</Notice></div>}
      {sp.blad && <div className="mb-4"><Notice tone="error">{sp.blad}</Notice></div>}

      <form className="mb-4 space-y-2" method="get">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-7">
          <input className="input col-span-2" name="q" defaultValue={sp.q} placeholder="Szukaj: nazwa, SKU, EAN, kod sztuki, IMEI" />
          <select className="input" name="sklep" defaultValue={sp.sklep ?? ""}>
            <option value="">Wszystkie sklepy</option>
            {stores?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select className="input" name="lokalizacja" defaultValue={sp.lokalizacja ?? ""}>
            <option value="">Wszystkie lokalizacje</option>
            {locations?.map((l) => <option key={l.id} value={l.id}>{storeName.get(l.store_id)} · {l.name}</option>)}
          </select>
          <select className="input" name="status" defaultValue={sp.status ?? ""}>
            <option value="">Dostępne (na stanie, w drodze, rezerwacje)</option>
            {Object.entries(UNIT_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            <option value="wszystkie">wszystkie statusy</option>
          </select>
          <select className="input" name="umowa" defaultValue={sp.umowa ?? ""}>
            <option value="">Umowa: wszystkie</option>
            <option value="brak">bez umowy</option>
            <option value="jest">z umową</option>
          </select>
          <select className="input" name="wlasciciel" defaultValue={sp.wlasciciel ?? ""}>
            <option value="">Własne i komis</option>
            <option value="own">własne</option>
            <option value="consignment">komis</option>
          </select>
        </div>
        <details className="rounded-md border border-line px-3 py-2" open={more}>
          <summary className="cursor-pointer text-sm font-medium">Więcej filtrów</summary>
          <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-6">
            <select className="input" name="komisant" defaultValue={sp.komisant ?? ""} aria-label="Komisant">
              <option value="">Komisant: każdy</option>
              {consignors?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select className="input" name="forma" defaultValue={sp.forma ?? ""} aria-label="Forma sprzedaży">
              <option value="">Forma: każda</option>
              {Object.entries(PURCHASE_FORM).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <input className="input" name="rozmiar" defaultValue={sp.rozmiar} placeholder="Rozmiar, np. 42" aria-label="Rozmiar" />
            <select className="input" name="imei" defaultValue={sp.imei ?? ""} aria-label="IMEI / numer seryjny">
              <option value="">IMEI: wszystkie</option>
              <option value="jest">z IMEI / nr seryjnym</option>
              <option value="brak">bez IMEI</option>
            </select>
            <div className="flex items-center gap-1"><input className="input" name="cena_od" inputMode="decimal" defaultValue={sp.cena_od} placeholder="Cena sklep od" aria-label="Cena w sklepie od" /><input className="input" name="cena_do" inputMode="decimal" defaultValue={sp.cena_do} placeholder="do" aria-label="Cena w sklepie do" /></div>
            {profile.can_see_prices && <div className="flex items-center gap-1"><input className="input" name="zakup_od" inputMode="decimal" defaultValue={sp.zakup_od} placeholder="Zakup od" aria-label="Cena zakupu od" /><input className="input" name="zakup_do" inputMode="decimal" defaultValue={sp.zakup_do} placeholder="do" aria-label="Cena zakupu do" /></div>}
            <label className="text-xs text-muted">Przyjęta od<input className="input mt-0.5" type="date" name="od" defaultValue={sp.od} /></label>
            <label className="text-xs text-muted">Przyjęta do<input className="input mt-0.5" type="date" name="do" defaultValue={sp.do} /></label>
          </div>
        </details>
        <div className="flex flex-wrap items-center gap-2">
          <select className="input w-56" name="sort" defaultValue={activeSort} aria-label="Sortuj według">
            {Object.entries(UNIT_SORTS).map(([k, v]) => <option key={k} value={k}>Sortuj: {v.label}</option>)}
          </select>
          <select className="input w-40" name="kier" defaultValue={activeAsc ? "asc" : "desc"} aria-label="Kierunek">
            <option value="desc">malejąco</option>
            <option value="asc">rosnąco</option>
          </select>
          <button className="btn">Filtruj</button>
          {Object.keys(filterParams).length > 0 && <Link className="text-sm text-muted underline" href="/magazyn">Wyczyść filtry</Link>}
        </div>
      </form>

      <form action={bulkAction}>
        <input type="hidden" name="returnTo" value={returnTo} />
        <input type="hidden" name="wroc" value={returnTo} />
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th className="w-8"><SelectAll /></th>
                <SortTh k="nazwa">Produkt</SortTh>
                <SortTh k="rozmiar">Rozmiar</SortTh>
                <SortTh k="kod">Kod</SortTh>
                <SortTh k="lokalizacja">Lokalizacja</SortTh>
                <SortTh k="status">Status</SortTh>
                <SortTh k="komisant">Komisant</SortTh>
                <SortTh k="cena" right>Cena w sklepie</SortTh>
                {profile.can_see_prices && <SortTh k="zakup" right>Cena zakupu</SortTh>}
                <SortTh k="przyjeta">Przyjęta</SortTh>
                <th className="text-right">Umowa</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={12} className="py-10 text-center text-muted">Brak sztuk dla tych filtrów.</td></tr>
              )}
              {rows.map((u) => (
                <tr key={u.id}>
                  <td><input type="checkbox" name="ids" value={u.id} className="h-4 w-4" aria-label={`Zaznacz ${u.code}`} /></td>
                  <td>
                    <Link href={`/magazyn/${u.id}`} className="flex items-center gap-3">
                      <Thumb src={u.variant.product.image_url} alt="" />
                      <span>
                        <span className="block font-medium leading-tight hover:underline">{u.variant.product.title}</span>
                        <span className="text-xs text-muted">{u.variant.product.style_sku ?? "bez SKU"}</span>
                      </span>
                    </Link>
                  </td>
                  <td className="whitespace-nowrap font-medium">
                    {u.variant.option}
                    {(() => {
                      const sku = u.variant.links.find((l) => l.store_id === u.location.store_id && l.base_sku)?.base_sku ?? u.variant.links.find((l) => l.base_sku)?.base_sku;
                      return sku ? <span className="block text-xs font-normal text-muted">Base {sku}</span> : null;
                    })()}
                  </td>
                  <td className="whitespace-nowrap font-mono text-xs">
                    {u.code}
                    {u.identifier && <span className="block text-muted">{u.identifier}</span>}
                  </td>
                  <td className="whitespace-nowrap">
                    {u.location.name}
                    <span className="block text-xs text-muted">{u.location.store.name}{u.shelf ? ` · ${u.shelf}` : ""}</span>
                  </td>
                  <td><StatusBadge status={u.status} /></td>
                  <td className="whitespace-nowrap">
                    {u.owner_type === "consignment" ? (
                      <>
                        <Link href={`/magazyn?wlasciciel=consignment&komisant=${u.consignor?.id}`} className="font-medium text-accent hover:underline">{u.consignor?.name}</Link>
                        {profile.can_see_prices && u.payout_amount !== null && <span className="block text-xs text-muted">w komisie {money(u.payout_amount)}</span>}
                      </>
                    ) : (
                      <span className="text-muted">– {OWNER_TYPE.own}</span>
                    )}
                    <span className="block text-xs text-muted">{PURCHASE_FORM[u.purchase_form]}</span>
                  </td>
                  <td className="whitespace-nowrap text-right tabular-nums">{money(shopPrice(u))}</td>
                  {profile.can_see_prices && <td className="whitespace-nowrap text-right tabular-nums">{money(u.purchase_price)}</td>}
                  <td className="whitespace-nowrap text-muted">{dateOnly(u.received_at)}</td>
                  <td className="whitespace-nowrap text-right">
                    {u.contract ? (
                      <a href={`/api/umowy/${u.contract.id}/pdf`} target="_blank" rel="noreferrer" className="text-accent hover:underline" title="Otwórz umowę">{u.contract.counterparty}</a>
                    ) : (
                      <Link href={`/umowy/z-szablonu?ids=${u.id}`} className="btn-secondary px-2.5 py-1 text-xs">
                        Dodaj umowę
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="sticky bottom-0 mt-3 flex flex-wrap items-end gap-2 rounded-lg border border-line bg-white/95 p-3 backdrop-blur">
          <span className="mr-2 text-sm text-muted">Zaznaczone:</span>
          <div className="flex items-end gap-2">
            <select className="input w-56" name="location_id" defaultValue="">
              <option value="">Przenieś do…</option>
              {locations?.map((l) => <option key={l.id} value={l.id}>{storeName.get(l.store_id)} · {l.name}</option>)}
            </select>
            <SubmitButton className="btn-secondary" name="action" value="move">Przenieś</SubmitButton>
          </div>
          <div className="flex items-end gap-2">
            <select className="input w-64" name="contract_id" defaultValue="">
              <option value="">Odepnij umowę / wybierz umowę…</option>
              {contracts?.map((c) => <option key={c.id} value={c.id}>{c.counterparty}{c.contract_date ? ` · ${dateOnly(c.contract_date)}` : ""}</option>)}
            </select>
            <SubmitButton className="btn-secondary" name="action" value="contract">Przypnij umowę</SubmitButton>
          </div>
          <button type="submit" className="btn-secondary" formAction="/umowy/z-szablonu" formMethod="get">Umowa dla zaznaczonych</button>
          <SubmitButton className="btn-secondary" name="action" value="receive">Przyjmij na stan (z „w drodze”)</SubmitButton>
          <button type="submit" className="btn-secondary" formAction="/etykiety" formMethod="get" formTarget="_blank">Drukuj etykietę</button>
          {profile.role === "admin" && (
            <ConfirmSubmit name="action" value="delete" className="btn-danger ml-auto" message="Usunąć zaznaczone sztuki z aplikacji? Stan w Base się nie zmieni. Sztuk ze sprzedażą nie da się usunąć.">
              Usuń zaznaczone
            </ConfirmSubmit>
          )}
        </div>
      </form>

      <Pagination page={page} total={count} perPage={PER_PAGE} params={filterParams} />
    </>
  );
}
