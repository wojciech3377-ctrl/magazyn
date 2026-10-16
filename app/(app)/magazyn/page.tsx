import { freeContracts } from "@/lib/contracts/free";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { parseProductTagCode } from "@/lib/price-tag-code";
import { parseCategories, queryUnits, UNIT_SORTS, type UnitFilters, type UnitRow } from "@/lib/queries/units";
import { CategoryPicker } from "@/components/CategoryPicker";
import { money, dateOnly, OWNER_TYPE, PURCHASE_FORM, UNIT_STATUS } from "@/lib/labels";
import { Notice, PageHeader, Pagination, Pill, StatusBadge, Thumb } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { ConfirmSubmit } from "@/components/ConfirmSubmit";
import { SelectAll } from "@/components/SelectAll";
import { bulkAction, runAutoCatalogNow } from "./actions";
import { CONTRACT_LITE_FIELDS, contractStage, isSettled, MISSING_BTN, type ContractLite } from "@/lib/contracts/stage";
import { ConsignorWaiting, ContractDone, ContractInProgress } from "@/components/ContractBadges";
import { Barcode } from "@/app/etykiety/Barcode";
import { FilterField, ListToolbar } from "@/components/ListToolbar";
import { BulkBar } from "@/components/BulkBar";
import { activeFilters, filterChips } from "@/lib/list-params";
import { ChangesPreview } from "./ChangesPreview";

// Przycisk „Sprawdź nowe produkty i stany” czyta cały katalog Shopify – potrzebuje dłuższego czasu.
export const maxDuration = 300;

const PER_PAGE = 100;

const FILTER_KEYS = ["sklep", "lokalizacja", "status", "umowa", "wlasciciel", "komisant", "forma", "rozmiar", "cena_od", "cena_do", "zakup_od", "zakup_do", "od", "do", "imei", "kat", "shopify"];

function sortOptions(prices: boolean) {
  return [
    { value: "przyjeta:desc", label: "Najnowsze" },
    { value: "przyjeta:asc", label: "Najstarsze" },
    { value: "nazwa:asc", label: "Nazwa A–Z" },
    { value: "nazwa:desc", label: "Nazwa Z–A" },
    { value: "cena:desc", label: "Najdroższe" },
    { value: "cena:asc", label: "Najtańsze" },
    ...(prices ? [{ value: "zakup:desc", label: "Zakup: najwyższy" }, { value: "zakup:asc", label: "Zakup: najniższy" }] : []),
    { value: "rozmiar:asc", label: "Rozmiar ↑" },
    { value: "rozmiar:desc", label: "Rozmiar ↓" },
    { value: "kod:desc", label: "Kod: najnowszy" },
    { value: "kod:asc", label: "Kod: najstarszy" },
    { value: "lokalizacja:asc", label: "Lokalizacja" },
    { value: "status:asc", label: "Status" },
    { value: "komisant:asc", label: "Komisant" },
  ];
}

/** Cena w sklepie, z którego jest lokalizacja sztuki (albo z dowolnego sklepu). */
function shopPrice(u: UnitRow) {
  return u.variant.links.find((l) => l.store_id === u.location.store_id && l.price !== null)?.price
    ?? u.variant.links.find((l) => l.price !== null)?.price
    ?? null;
}

/** Magazyn pokazuje tylko rzeczy, które fizycznie są u nas (sprzedane i oddane komisantowi są w Sprzedaży / JPK / historii sztuki). */
const MAGAZYN_STATUSES = ["in_stock", "reserved", "in_transit", "consignor_hold", "returned"];

export default async function MagazynPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { supabase, profile } = await requireProfile();
  // Zeskanowany kod z metki produktu (PR000123) – od razu stan produktu i dostępne rozmiary.
  if (sp.q && parseProductTagCode(sp.q) !== null) redirect(`/magazyn/produkt/${encodeURIComponent(sp.q.trim().toUpperCase())}`);
  const page = Math.max(1, Number(sp.strona ?? 1));
  const filters: UnitFilters = {
    q: sp.q, sklep: sp.sklep, lokalizacja: sp.lokalizacja, status: MAGAZYN_STATUSES.includes(sp.status ?? "") ? sp.status : undefined, umowa: sp.umowa, wlasciciel: sp.wlasciciel, komisant: sp.komisant,
    forma: sp.forma, rozmiar: sp.rozmiar, cena_od: sp.cena_od, cena_do: sp.cena_do, zakup_od: sp.zakup_od, zakup_do: sp.zakup_do,
    od: sp.od, do: sp.do, imei: sp.imei, kat: sp.kat, shopify: sp.shopify, sort: sp.sort, kier: sp.kier,
  };
  const pickedCats = parseCategories(sp.kat);
  const more = false;

  const [unitsRes, { data: stores }, { data: locations }, { data: contracts }, { count: noContract }, { data: consignors }, { count: unusedContracts }, { data: cols }] = await Promise.all([
    // Filtr kategorii bez SQL 58 – komunikat zamiast błędu strony.
    queryUnits(supabase, filters, [(page - 1) * PER_PAGE, page * PER_PAGE - 1]).catch((e) => {
      if (pickedCats.length || sp.shopify) return { rows: [] as UnitRow[], count: 0, catError: true };
      throw e;
    }),
    supabase.from("stores").select("id, name").order("name"),
    supabase.from("locations").select("id, name, store_id").eq("active", true).order("name"),
    freeContracts(supabase).then((data) => ({ data })),
    supabase.from("units").select("id", { count: "exact", head: true }).is("contract_id", null).in("status", ["in_stock", "in_transit", "reserved"]),
    supabase.from("consignors").select("id, name").order("name"),
    supabase.from("contracts_unused").select("id", { count: "exact", head: true }),
    supabase.from("shop_collections").select("title, store_id").gt("products_count", 0).limit(2000),
  ]);
  const { rows, count } = unitsRes;
  const catError = "catError" in unitsRes;
  // Kategorie z ich sklepami – lista w filtrze pokazuje tylko kategorie sklepu wybranego w polu „Sklep”.
  const catStores = new Map<string, Set<string>>();
  for (const c of cols ?? []) {
    const t = (c.title as string).trim();
    catStores.set(t, (catStores.get(t) ?? new Set()).add(c.store_id as string));
  }
  for (const t of pickedCats) if (!catStores.has(t)) catStores.set(t, new Set());
  const categories = [...catStores.entries()].map(([title, st]) => ({ title, stores: [...st] })).sort((a, b) => a.title.localeCompare(b.title, "pl"));

  // Etap umów widocznych sztuk (zielony / pomarańczowy).
  const contractIds = [...new Set(rows.map((r) => r.contract_id).filter((x): x is string => !!x))];
  // Shopify: SKU rozmiaru, wersja robocza (draft) i tag „reused” produktu w sklepie sztuki.
  const productIds = [...new Set(rows.map((r) => r.variant.product.id))];
  const variantIds = [...new Set(rows.map((r) => r.variant.id))];
  const [{ data: contractRows }, { data: pLinks }, { data: vLinks }, { data: prodFlags }] = await Promise.all([
    contractIds.length ? supabase.from("contracts").select(CONTRACT_LITE_FIELDS).in("id", contractIds) : Promise.resolve({ data: [] }),
    productIds.length ? supabase.from("product_store_links").select("product_id, store_id, status, tags").in("product_id", productIds) : Promise.resolve({ data: [] }),
    variantIds.length ? supabase.from("variant_store_links").select("variant_id, store_id, sku").in("variant_id", variantIds) : Promise.resolve({ data: [] }),
    // Produkty spoza katalogu Shopify („nieprzypisany do Shopify”) – bez SQL 63 kolumny nie ma, wtedy nic.
    productIds.length ? supabase.from("products").select("*").in("id", productIds).then((r) => r, () => ({ data: [] })) : Promise.resolve({ data: [] }),
  ]);
  const unassignedIds = new Set(((prodFlags ?? []) as { id: string; unassigned?: boolean }[]).filter((p) => p.unassigned).map((p) => p.id));
  const contractById = new Map((contractRows ?? []).map((c) => [c.id as string, c as unknown as ContractLite]));
  type PL = { product_id: string; store_id: string; status: string | null; tags: string[] | null };
  const shopOf = (productId: string, storeId: string) => {
    const ls = ((pLinks ?? []) as PL[]).filter((l) => l.product_id === productId);
    const mine = ls.filter((l) => l.store_id === storeId);
    const use = mine.length ? mine : ls;
    return {
      draft: use.length > 0 && use.every((l) => (l.status ?? "").toUpperCase() === "DRAFT"),
      reused: use.some((l) => (l.tags ?? []).some((t) => t.toLowerCase() === "reused")),
    };
  };
  const skuOf = (variantId: string, storeId: string) => {
    const ls = ((vLinks ?? []) as { variant_id: string; store_id: string; sku: string | null }[]).filter((l) => l.variant_id === variantId && l.sku);
    return (ls.find((l) => l.store_id === storeId) ?? ls[0])?.sku ?? null;
  };

  const filterParams = Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) as Record<string, string>;
  const qs = new URLSearchParams(filterParams).toString();
  const returnTo = `/magazyn${qs ? `?${qs}` : ""}`;
  const storeName = new Map((stores ?? []).map((s) => [s.id, s.name]));
  const activeSort = UNIT_SORTS[sp.sort ?? ""] ? sp.sort! : "przyjeta";
  const activeAsc = sp.kier === "asc" ? true : sp.kier === "desc" ? false : UNIT_SORTS[activeSort].asc;
  /** Link sortowania (w nagłówkach łączących dwie kolumny). */
  const SortLink = ({ k, children }: { k: string; children: React.ReactNode }) => {
    const on = activeSort === k;
    const params = new URLSearchParams({ ...filterParams, sort: k, kier: on ? (activeAsc ? "desc" : "asc") : (UNIT_SORTS[k].asc ? "asc" : "desc") });
    params.delete("strona");
    return <Link href={`/magazyn?${params}`} className={`inline-flex items-center gap-0.5 hover:text-ink ${on ? "text-ink" : ""}`}>{children}<span className="text-[10px]">{on ? (activeAsc ? "▲" : "▼") : "↕"}</span></Link>;
  };
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
        sub={<>{count} szt. w widoku{noContract ? <> · <Link className="text-accent underline" href="/magazyn?umowa=brak">{noContract} na stanie bez umowy</Link></> : null}{unusedContracts ? <> · <Link className="text-accent underline" href="/umowy?kategoria=bez-rzeczy">{unusedContracts} umów bez rzeczy</Link></> : null}</>}
        actions={
          <>
            {profile.role === "admin" && <form action={runAutoCatalogNow}><SubmitButton className="btn-secondary" pendingText="Sprawdzam…">Sprawdź nowe produkty i stany</SubmitButton></form>}
            {profile.role === "admin" && filters.q && <Link className="btn-secondary" href={`/ustawienia?zakladka=stany&sprawdz=${encodeURIComponent(filters.q)}#sprawdz`}>Porównaj „{filters.q.slice(0, 20)}” ze Shopify</Link>}
            <Link className="btn" href="/magazyn/produkty">Stan produktu + metka</Link>
            <Link className="btn-secondary" href="/magazyn/przesuniecie">Wyślij na inny magazyn</Link>
            <Link className="btn-secondary" href="/magazyn/inwentaryzacja">Inwentaryzacja</Link>
            <Link className="btn-secondary" href="/magazyn/historia">Historia</Link>
            <Link className="btn-secondary" href={`/api/eksport/sztuki${qs ? `?${qs}` : ""}`}>Eksport CSV</Link>
          </>
        }
      />

      {sp.ok && <div className="mb-4"><Notice tone="ok">{sp.ok}</Notice></div>}
      {sp.zmiany && <ChangesPreview id={sp.zmiany} />}
      {sp.blad && <div className="mb-4"><Notice tone="error">{sp.blad}</Notice></div>}
      {catError && <div className="mb-4"><Notice tone="error">{sp.shopify ? "Filtr „Nieprzypisane do Shopify” wymaga SQL 63 w Supabase." : "Filtr kategorii wymaga SQL 58 w Supabase (kolekcje ze Shopify)."}</Notice></div>}

      <ListToolbar
        q={sp.q}
        placeholder="Nazwa, SKU, EAN, kod sztuki, IMEI"
        sort={{ value: `${activeSort}:${activeAsc ? "asc" : "desc"}`, options: sortOptions(profile.can_see_prices) }}
        active={activeFilters(sp, FILTER_KEYS)}
        defaultOpen={more}
        resetHref={`/magazyn${sp.q ? `?q=${encodeURIComponent(sp.q)}` : ""}`}
        chips={[...filterChips("/magazyn", filterParams, {
          q: (v) => `„${v}”`,
          sklep: (v) => storeName.get(v) ?? null,
          lokalizacja: (v) => locations?.find((l) => l.id === v)?.name ?? null,
          status: (v) => UNIT_STATUS[v] ?? null,
          umowa: (v) => (v === "brak" ? "bez umowy" : "z umową"),
          wlasciciel: (v) => (v === "own" ? "własne" : "komis"),
          komisant: (v) => consignors?.find((c) => c.id === v)?.name ?? "komisant",
          forma: (v) => PURCHASE_FORM[v] ?? null,
          rozmiar: (v) => `rozmiar ${v}`,
          imei: (v) => (v === "jest" ? "z IMEI" : "bez IMEI"),
          shopify: (v) => (v === "nieprzypisane" ? "nieprzypisane do Shopify" : null),
          cena_od: (v) => `cena od ${v} zł`,
          cena_do: (v) => `cena do ${v} zł`,
          zakup_od: (v) => `zakup od ${v} zł`,
          zakup_do: (v) => `zakup do ${v} zł`,
          od: (v) => `przyjęta od ${v}`,
          do: (v) => `przyjęta do ${v}`,
        }), ...pickedCats.map((c) => {
          // Każda kategoria osobno – „×” usuwa tylko ją.
          const rest = new URLSearchParams(Object.entries(filterParams).filter(([k]) => k !== "strona"));
          const left = pickedCats.filter((x) => x !== c);
          if (left.length) rest.set("kat", left.join("|")); else rest.delete("kat");
          return { label: c, href: `/magazyn${rest.size ? `?${rest}` : ""}` };
        })]}
      >
        <FilterField label="Sklep">
          <select className="input" name="sklep" defaultValue={sp.sklep ?? ""}>
            <option value="">Wszystkie sklepy</option>
            {stores?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </FilterField>
        {categories.length > 0 && (
          <FilterField label="Kategorie (kolekcje Shopify)" wide group>
            <CategoryPicker key={`${sp.kat ?? ""}|${sp.sklep ?? ""}`} name="kat" options={categories} defaultValue={pickedCats} storeField="sklep" />
          </FilterField>
        )}
        <FilterField label="Lokalizacja">
          <select className="input" name="lokalizacja" defaultValue={sp.lokalizacja ?? ""}>
            <option value="">Wszystkie lokalizacje</option>
            {locations?.map((l) => <option key={l.id} value={l.id}>{storeName.get(l.store_id)} · {l.name}</option>)}
          </select>
        </FilterField>
        <FilterField label="Status">
          <select className="input" name="status" defaultValue={MAGAZYN_STATUSES.includes(sp.status ?? "") ? sp.status : ""}>
            <option value="">Dostępne (na stanie, w drodze, rezerwacje)</option>
            {MAGAZYN_STATUSES.map((k) => <option key={k} value={k}>{UNIT_STATUS[k]}</option>)}
          </select>
        </FilterField>
        <FilterField label="Własne / komis">
          <select className="input" name="wlasciciel" defaultValue={sp.wlasciciel ?? ""}>
            <option value="">Własne i komis</option>
            <option value="own">Własne</option>
            <option value="consignment">Komis</option>
          </select>
        </FilterField>
        <FilterField label="Komisant">
          <select className="input" name="komisant" defaultValue={sp.komisant ?? ""}>
            <option value="">Każdy</option>
            {consignors?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </FilterField>
        <FilterField label="Umowa">
          <select className="input" name="umowa" defaultValue={sp.umowa ?? ""}>
            <option value="">Wszystkie</option>
            <option value="brak">Bez umowy</option>
            <option value="jest">Z umową</option>
          </select>
        </FilterField>
        <FilterField label="Forma sprzedaży">
          <select className="input" name="forma" defaultValue={sp.forma ?? ""}>
            <option value="">Każda</option>
            {Object.entries(PURCHASE_FORM).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </FilterField>
        <FilterField label="IMEI / numer seryjny">
          <select className="input" name="imei" defaultValue={sp.imei ?? ""}>
            <option value="">Wszystkie</option>
            <option value="jest">Z IMEI / nr seryjnym</option>
            <option value="brak">Bez IMEI</option>
          </select>
        </FilterField>
        <FilterField label="Shopify">
          <select className="input" name="shopify" defaultValue={sp.shopify ?? ""}>
            <option value="">Wszystkie</option>
            <option value="nieprzypisane">Nieprzypisane do Shopify</option>
          </select>
        </FilterField>
        <FilterField label="Rozmiar">
          <input className="input" name="rozmiar" defaultValue={sp.rozmiar} placeholder="np. 42" />
        </FilterField>
        <FilterField label="Cena w sklepie (zł)">
          <span className="flex items-center gap-1.5"><input className="input" name="cena_od" inputMode="decimal" defaultValue={sp.cena_od} placeholder="od" aria-label="Cena od" /><span className="text-muted">–</span><input className="input" name="cena_do" inputMode="decimal" defaultValue={sp.cena_do} placeholder="do" aria-label="Cena do" /></span>
        </FilterField>
        {profile.can_see_prices && (
          <FilterField label="Cena zakupu (zł)">
            <span className="flex items-center gap-1.5"><input className="input" name="zakup_od" inputMode="decimal" defaultValue={sp.zakup_od} placeholder="od" aria-label="Zakup od" /><span className="text-muted">–</span><input className="input" name="zakup_do" inputMode="decimal" defaultValue={sp.zakup_do} placeholder="do" aria-label="Zakup do" /></span>
          </FilterField>
        )}
        <FilterField label="Przyjęta (od – do)" wide>
          <span className="flex items-center gap-1.5"><input className="input" type="date" name="od" defaultValue={sp.od} aria-label="Przyjęta od" /><span className="text-muted">–</span><input className="input" type="date" name="do" defaultValue={sp.do} aria-label="Przyjęta do" /></span>
        </FilterField>
      </ListToolbar>

      <form action={bulkAction}>
        <input type="hidden" name="returnTo" value={returnTo} />
        <input type="hidden" name="wroc" value={returnTo} />
        <Pagination page={page} total={count} perPage={PER_PAGE} params={filterParams} top />
        <div id="magazyn-tabela" className="card overflow-x-auto">
          <table className="table mtable [&_td]:px-2 [&_th]:px-2" style={{ "--m-cols": "1.5rem minmax(0,1fr) auto", "--m-areas": "'chk prod prod' '. size price' '. place place' '. code buy' '. owner owner' '. act act'" } as React.CSSProperties}>
            <thead>
              <tr>
                <th className="w-8"><SelectAll /></th>
                <SortTh k="nazwa">Produkt</SortTh>
                <SortTh k="rozmiar">Rozmiar</SortTh>
                <th><SortLink k="kod">Kod</SortLink></th>
                <th><SortLink k="lokalizacja">Miejsce</SortLink> · <SortLink k="status">status</SortLink></th>
                <SortTh k="komisant">Komisant</SortTh>
                <SortTh k="cena" right>Cena</SortTh>
                {profile.can_see_prices && <SortTh k="zakup" right>Zakup</SortTh>}
                <th className="text-right"><SortLink k="przyjeta">Przyjęta</SortLink> · umowa</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={9} className="py-10 text-center text-muted">Brak sztuk dla tych filtrów.</td></tr>
              )}
              {rows.map((u) => {
                const sku = skuOf(u.variant.id, u.location.store_id);
                const shop = shopOf(u.variant.product.id, u.location.store_id);
                const c = u.contract_id ? contractById.get(u.contract_id) : undefined;
                const stage = c ? contractStage(c) : null;
                return (
                <tr key={u.id}>
                  <td style={{ gridArea: "chk" }}><input type="checkbox" name="ids" value={u.id} className="h-4 w-4 max-md:mt-3" aria-label={`Zaznacz ${u.code}`} /></td>
                  <td className="min-w-48" style={{ gridArea: "prod" }}>
                    <Link href={`/magazyn/${u.id}`} className="flex items-center gap-2.5">
                      <Thumb src={u.variant.product.image_url} alt="" />
                      <span className="min-w-0">
                        <span className="line-clamp-2 font-medium leading-tight hover:underline">{u.variant.product.title}{shop.reused && <span className="ml-1.5 inline-block rounded-full bg-amber-100 px-1.5 py-px align-middle text-[11px] font-semibold text-amber-800" title="Tag w Shopify: reused (używane)">reused</span>}</span>
                        <span className="block break-all text-xs text-muted">{u.variant.product.style_sku ?? "bez SKU"}</span>
                        {unassignedIds.has(u.variant.product.id) ? (
                          <span className="mt-0.5 flex flex-wrap gap-1">
                            <span className="rounded bg-orange-100 px-1.5 py-0.5 text-[11px] font-semibold text-orange-800" title="Rzecz spoza katalogu – przypisz ją do produktu z Shopify na karcie sztuki">nieprzypisany do Shopify</span>
                          </span>
                        ) : u.shop_missing && (
                          <span className="mt-0.5 flex flex-wrap gap-1">
                            <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[11px] font-semibold text-bad" title="Tego rozmiaru nie ma w żadnym sklepie Shopify">brak w Shopify</span>
                            {u.contract_id && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-800" title="Sztuka ma umowę – nie usuwamy jej automatycznie">umowa nadal aktywna</span>}
                          </span>
                        )}
                      </span>
                    </Link>
                  </td>
                  <td className="font-medium" style={{ gridArea: "size" }}>
                    <span className="mr-1 text-xs font-normal text-muted md:hidden">Rozmiar</span>{u.variant.option}
                    {sku && <span className="block break-all text-xs font-normal text-muted">{sku}</span>}
                  </td>
                  <td className="font-mono text-xs" style={{ gridArea: "code" }}>
                    {u.code}
                    {u.identifier && <span className="block break-all text-muted max-md:ml-2 max-md:inline">IMEI {u.identifier}</span>}
                    <span className="mt-1 block max-md:hidden" title={`Kod kreskowy sztuki: ${u.code}`}><Barcode value={u.code} className="h-[18px] w-[92px]" /></span>
                  </td>
                  <td className="text-sm max-md:flex max-md:flex-wrap max-md:items-center max-md:gap-x-2" style={{ gridArea: "place" }}>
                    <span className="block leading-tight max-md:text-xs max-md:text-muted">{u.location.name}<span className="md:hidden"> · {u.location.store.name}{u.shelf ? ` · ${u.shelf}` : ""}</span></span>
                    <span className="block text-xs text-muted max-md:hidden">{u.location.store.name}{u.shelf ? ` · ${u.shelf}` : ""}</span>
                    <span className="mt-1 block max-md:order-first max-md:mt-0">{u.status === "in_stock" && shop.draft
                      ? <span className="inline-flex items-center whitespace-nowrap rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700 ring-1 ring-inset ring-slate-300" title="Produkt w Shopify jest wersją roboczą (niewidoczny w sklepie)">na stanie – wersja robocza</span>
                      : <StatusBadge status={u.status} />}</span>
                  </td>
                  <td className="max-w-44 max-md:flex max-md:flex-wrap max-md:items-baseline max-md:gap-x-2 max-md:text-xs" style={{ gridArea: "owner" }}>
                    {u.owner_type === "consignment" ? (
                      <>
                        <Link href={`/magazyn?wlasciciel=consignment&komisant=${u.consignor?.id}`} className="line-clamp-2 break-words text-sm font-medium leading-tight text-accent hover:underline" title={u.consignor?.name}>{u.consignor?.name}</Link>
                        {profile.can_see_prices && u.payout_amount !== null && <span className="block text-xs text-muted">w komisie {(() => { const ct = u.contract_id ? contractById.get(u.contract_id) : null; return ct?.currency && ct.currency !== "PLN" ? `${Number(u.payout_amount).toFixed(2)} ${ct.currency}` : money(u.payout_amount); })()}</span>}
                      </>
                    ) : (
                      <span className="text-sm text-muted max-md:text-xs">– {OWNER_TYPE.own}</span>
                    )}
                    <span className="block text-xs text-muted max-md:before:content-['·_']">{PURCHASE_FORM[u.purchase_form]}</span>
                  </td>
                  <td className="whitespace-nowrap text-right tabular-nums max-md:text-base" style={{ gridArea: "price" }}>
                    {shopPrice(u) !== null ? <b>{money(shopPrice(u))}</b> : u.price_error ? (
                      <span className="group relative inline-block cursor-help" tabIndex={0} aria-label={`Błąd ceny: ${u.price_error}`}>
                        <span className="rounded bg-rose-100 px-1.5 py-0.5 text-xs font-bold text-bad">BŁĄD</span>
                        <span role="tooltip" className="pointer-events-none absolute right-0 top-full z-30 mt-1 hidden w-72 whitespace-normal rounded-md border border-line bg-white p-2 text-left text-xs font-normal text-ink shadow-lg group-hover:block group-focus:block">{u.price_error}</span>
                      </span>
                    ) : "–"}
                  </td>
                  {profile.can_see_prices && (
                    <td className="whitespace-nowrap text-right tabular-nums max-md:text-xs max-md:text-muted" style={{ gridArea: "buy" }}>
                      <span className="md:hidden">zakup </span>
                      {(() => {
                        // Komis bez ceny zakupu: kwota komisanta. Waluta z umowy (np. EUR).
                        const value = u.purchase_price ?? (u.owner_type === "consignment" ? u.payout_amount : null);
                        const cur = c?.currency && c.currency !== "PLN" ? c.currency : null;
                        if (value === null) return "–";
                        return <>{cur ? `${Number(value).toFixed(2)} ${cur}` : money(value)}{u.purchase_price === null && <span className="block text-[11px] text-muted">kwota komisanta</span>}</>;
                      })()}
                    </td>
                  )}
                  <td className="text-right" style={{ gridArea: "act" }}>
                    <div className="flex flex-col items-end gap-1 max-md:flex-row max-md:flex-wrap max-md:items-center max-md:justify-start max-md:gap-2 max-md:pt-1">
                      <span className="text-xs text-muted">{dateOnly(u.received_at)}</span>
                      {c && isSettled(stage) ? <ContractDone c={c} stage={stage!} label={`${c.counterparty ?? "umowa"} ✓`} />
                        : c && stage && stage !== "dead" ? <ContractInProgress c={c} stage={stage} />
                        : u.owner_type === "consignment" && ["sold", "shipped"].includes(u.status) ? <ConsignorWaiting />
                        : <Link href={`/sprzedaz/umowa?sztuka=${u.id}&back=${encodeURIComponent(returnTo)}`} className={MISSING_BTN}>Dodaj umowę</Link>}
                      <a href={`/metka?ids=${u.id}`} target="_blank" rel="noreferrer" className="btn-secondary whitespace-nowrap px-2.5 py-1 text-xs">Wydrukuj metkę</a>
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <BulkBar scrollFor="magazyn-tabela">
          <div className="flex w-full items-end gap-2 md:w-auto">
            <select className="input min-w-0 flex-1 md:w-56 md:flex-none" name="location_id" defaultValue="">
              <option value="">Przenieś do…</option>
              {locations?.map((l) => <option key={l.id} value={l.id}>{storeName.get(l.store_id)} · {l.name}</option>)}
            </select>
            <SubmitButton className="btn-secondary" name="action" value="move">Przenieś</SubmitButton>
          </div>
          <div className="flex w-full items-end gap-2 md:w-auto">
            <select className="input min-w-0 flex-1 md:w-64 md:flex-none" name="contract_id" defaultValue="">
              <option value="">Odepnij umowę / wybierz umowę…</option>
              {contracts?.map((c) => <option key={c.id} value={c.id}>{c.label}{c.contract_date ? ` · ${dateOnly(c.contract_date)}` : ""}</option>)}
            </select>
            <SubmitButton className="btn-secondary" name="action" value="contract">Przypnij umowę</SubmitButton>
          </div>
          <button type="submit" className="btn-secondary" formAction="/umowy/z-szablonu" formMethod="get">Umowa dla zaznaczonych</button>
          <SubmitButton className="btn-secondary" name="action" value="receive">Przyjmij na stan (z „w drodze”)</SubmitButton>
          <ConfirmSubmit name="action" value="consignor_return" className="btn-secondary" message="Oddać zaznaczone rzeczy komisantowi? Znikną z magazynu (stan w Shopify −1), historia zostanie w karcie sztuki.">
            Wysyłka do komisanta
          </ConfirmSubmit>
          <button type="submit" className="btn-secondary" formAction="/etykiety" formMethod="get" formTarget="_blank">Drukuj etykietę</button>
          <button type="submit" className="btn-secondary" formAction="/metka" formMethod="get" formTarget="_blank">Wydrukuj metki</button>
          {profile.role === "admin" && (
            <ConfirmSubmit name="action" value="delete" className="btn-danger md:ml-auto" message="Usunąć zaznaczone sztuki z aplikacji? Stan w Shopify się nie zmieni. Sztuk ze sprzedażą nie da się usunąć.">
              Usuń zaznaczone
            </ConfirmSubmit>
          )}
        </BulkBar>
      </form>

      <Pagination page={page} total={count} perPage={PER_PAGE} params={filterParams} />
    </>
  );
}
