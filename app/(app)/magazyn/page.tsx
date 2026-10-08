import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { queryUnits, type UnitFilters } from "@/lib/queries/units";
import { money, dateOnly, OWNER_TYPE, PURCHASE_FORM, UNIT_STATUS } from "@/lib/labels";
import { Notice, PageHeader, Pagination, Pill, StatusBadge, Thumb } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { ConfirmSubmit } from "@/components/ConfirmSubmit";
import { SelectAll } from "@/components/SelectAll";
import { bulkAction } from "./actions";

const PER_PAGE = 100;

export default async function MagazynPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { supabase, profile } = await requireProfile();
  const page = Math.max(1, Number(sp.strona ?? 1));
  const filters: UnitFilters = {
    q: sp.q, sklep: sp.sklep, lokalizacja: sp.lokalizacja, status: sp.status, umowa: sp.umowa, wlasciciel: sp.wlasciciel, komisant: sp.komisant,
  };

  const [{ rows, count }, { data: stores }, { data: locations }, { data: contracts }, { count: noContract }] = await Promise.all([
    queryUnits(supabase, filters, [(page - 1) * PER_PAGE, page * PER_PAGE - 1]),
    supabase.from("stores").select("id, name").order("name"),
    supabase.from("locations").select("id, name, store_id").eq("active", true).order("name"),
    supabase.from("contracts").select("id, type, counterparty, contract_date").order("created_at", { ascending: false }).limit(200),
    supabase.from("units").select("id", { count: "exact", head: true }).is("contract_id", null).in("status", ["in_stock", "in_transit", "reserved"]),
  ]);

  const filterParams = Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) as Record<string, string>;
  const qs = new URLSearchParams(filterParams).toString();
  const returnTo = `/magazyn${qs ? `?${qs}` : ""}`;
  const storeName = new Map((stores ?? []).map((s) => [s.id, s.name]));

  return (
    <>
      <PageHeader
        title="Magazyn"
        sub={<>{count} szt. w widoku{noContract ? <> · <Link className="text-accent underline" href="/magazyn?umowa=brak">{noContract} na stanie bez umowy</Link></> : null}</>}
        actions={
          <>
            <Link className="btn-secondary" href={`/api/eksport/sztuki${qs ? `?${qs}` : ""}`}>Eksport CSV</Link>
            <Link className="btn" href="/dostawa">Przyjmij dostawę</Link>
          </>
        }
      />

      {sp.ok && <div className="mb-4"><Notice tone="ok">{sp.ok}</Notice></div>}
      {sp.blad && <div className="mb-4"><Notice tone="error">{sp.blad}</Notice></div>}

      <form className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-7" method="get">
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
        <div className="flex gap-2">
          <select className="input" name="wlasciciel" defaultValue={sp.wlasciciel ?? ""}>
            <option value="">Własne i komis</option>
            <option value="own">własne</option>
            <option value="consignment">komis</option>
          </select>
          <button className="btn">Filtruj</button>
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
                <th>Produkt</th>
                <th>Rozmiar</th>
                <th>Kod</th>
                <th>Lokalizacja</th>
                <th>Status</th>
                <th>Właściciel</th>
                {profile.can_see_prices && <th className="text-right">Cena zakupu</th>}
                <th>Przyjęta</th>
                <th className="text-right">Umowa</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={10} className="py-10 text-center text-muted">Brak sztuk dla tych filtrów.</td></tr>
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
                    {u.owner_type === "consignment" ? <Pill tone="blue">komis · {u.consignor?.name}</Pill> : <span className="text-muted">{OWNER_TYPE.own}</span>}
                    <span className="block text-xs text-muted">{PURCHASE_FORM[u.purchase_form]}</span>
                  </td>
                  {profile.can_see_prices && <td className="whitespace-nowrap text-right tabular-nums">{money(u.purchase_price)}</td>}
                  <td className="whitespace-nowrap text-muted">{dateOnly(u.received_at)}</td>
                  <td className="whitespace-nowrap text-right">
                    {u.contract ? (
                      <Link href={`/umowy/${u.contract.id}`} className="text-accent hover:underline">{u.contract.counterparty}</Link>
                    ) : (
                      <Link href={`/umowy/nowa?sztuki=${u.code}&wroc=${encodeURIComponent(returnTo)}`} className="btn-secondary px-2.5 py-1 text-xs">
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
          <button type="submit" className="btn-secondary" formAction="/umowy/nowa" formMethod="get">Nowa umowa dla zaznaczonych</button>
          <SubmitButton className="btn-secondary" name="action" value="receive">Przyjmij na stan (z „w drodze”)</SubmitButton>
          <button type="submit" className="btn-secondary" formAction="/etykiety" formMethod="get" formTarget="_blank">Drukuj etykiety</button>
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
