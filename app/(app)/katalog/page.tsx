import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { findVariantIds } from "@/lib/queries/units";
import { dateTime } from "@/lib/labels";
import { Notice, PageHeader, Pagination, Pill, Thumb } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { saveOwnProduct, toggleOwnProduct } from "./actions";
import { SyncPanel } from "./SyncPanel";
import { createAdminClient } from "@/lib/supabase/admin";
import { getFiscalSettings, PTU_LETTERS, ptuLabel, type FiscalSettings } from "@/lib/fiscal/jobs";
import { money } from "@/lib/labels";
import { FilterField, ListToolbar } from "@/components/ListToolbar";
import { activeFilters, filterChips } from "@/lib/list-params";

const CATALOG_SORTS: Record<string, { label: string; column: string; asc: boolean }> = {
  nazwa: { label: "Nazwa A–Z", column: "title", asc: true },
  "nazwa-z": { label: "Nazwa Z–A", column: "title", asc: false },
  zmienione: { label: "Ostatnio zmienione", column: "updated_at", asc: false },
  nowe: { label: "Ostatnio dodane", column: "created_at", asc: false },
};

const PER_PAGE = 50;

export default async function KatalogPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { supabase, profile } = await requireProfile();
  const tab = sp.widok === "wlasne" ? "wlasne" : "produkty";
  const page = Math.max(1, Number(sp.strona ?? 1));
  const { data: stores } = await supabase.from("stores").select("id, name, shopify_domain").order("name");
  const storeName = new Map((stores ?? []).map((s) => [s.id, s.name]));

  const [{ count: products }, own] = await Promise.all([
    supabase.from("products").select("id", { count: "exact", head: true }),
    supabase.from("pos_products").select("id", { count: "exact", head: true }).eq("active", true),
  ]);

  return (
    <>
      <PageHeader title="Katalog" sub={`${products ?? 0} produktów ze Shopify · ${own.count ?? 0} własnych produktów (spoza Shopify)`} />
      {sp.ok && <div className="mb-4"><Notice tone="ok">{sp.ok}</Notice></div>}
      {sp.blad && <div className="mb-4"><Notice tone="error">{sp.blad}</Notice></div>}

      <nav className="segmented mb-5 max-w-full overflow-x-auto whitespace-nowrap" aria-label="Katalog">
        <Link href="/katalog" aria-current={tab === "produkty" ? "page" : undefined}>Produkty ze Shopify</Link>
        <Link href="/katalog?widok=wlasne" aria-current={tab === "wlasne" ? "page" : undefined}>Własne produkty ({own.count ?? 0})</Link>
      </nav>

      {tab === "produkty" ? <>{profile.role === "admin" && <SyncPanel stores={stores ?? []} />}<Products sp={sp} page={page} /></> : <OwnProducts fiscal={await getFiscalSettings(createAdminClient())} edit={sp.edytuj} />}
    </>
  );

  async function Products({ sp, page }: { sp: Record<string, string | undefined>; page: number }) {
    const sort = CATALOG_SORTS[sp.sort ?? ""] ? sp.sort! : "nazwa";
    const inner = sp.sklep || sp.status || sp.uzywane;
    let query = supabase
      .from("products")
      .select(`id, title, style_sku, image_url, updated_at, stores:product_store_links${inner ? "!inner" : ""}(store_id, status, tags), variants(id, option, position, links:variant_store_links(store_id, sku, shopify_qty))`, { count: "exact" })
      .order(CATALOG_SORTS[sort].column, { ascending: CATALOG_SORTS[sort].asc })
      .range((page - 1) * PER_PAGE, page * PER_PAGE - 1);
    if (sp.sklep) query = query.eq("stores.store_id", sp.sklep);
    if (sp.status === "robocza") query = query.eq("stores.status", "DRAFT");
    if (sp.status === "aktywny") query = query.eq("stores.status", "ACTIVE");
    if (sp.uzywane === "tak") query = query.contains("stores.tags", ["reused"]);
    if (sp.q) {
      const ids = await findVariantIds(supabase, sp.q.replace(/[,()*%\\]/g, " ").trim());
      const { data: pids } = ids.length ? await supabase.from("variants").select("product_id").in("id", ids.slice(0, 150)) : { data: [] };
      query = query.in("id", [...new Set((pids ?? []).map((p) => p.product_id))].slice(0, 100).concat("00000000-0000-0000-0000-000000000000"));
    }
    const { data, count } = await query;
    const listParams = { q: sp.q, sklep: sp.sklep, status: sp.status, uzywane: sp.uzywane, sort: sp.sort };
    // Stan wyłącznie ze Shopify (suma sklepów; odczyt co 15 min i na żywo przez webhooki).
    const shopQty = (links: { shopify_qty?: number | null }[]) => links.reduce((n, l) => n + Math.max(0, Number(l.shopify_qty ?? 0)), 0);
    const collator = new Intl.Collator("pl", { numeric: true });

    return (
      <>
        <ListToolbar
          q={sp.q}
          placeholder="Nazwa, SKU, EAN"
          sort={{ value: sort, options: Object.entries(CATALOG_SORTS).map(([value, o]) => ({ value, label: o.label })) }}
          dirParam={null}
          active={activeFilters(sp, ["sklep", "status", "uzywane"])}
          resetHref="/katalog"
          chips={filterChips("/katalog", listParams, {
            q: (v) => `„${v}”`,
            sklep: (v) => storeName.get(v),
            status: (v) => (v === "robocza" ? "wersje robocze" : "aktywne w sklepie"),
            uzywane: () => "tag reused",
          })}
        >
          <FilterField label="Sklep">
            <select className="input" name="sklep" defaultValue={sp.sklep ?? ""}>
              <option value="">Wszystkie sklepy</option>
              {stores?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </FilterField>
          <FilterField label="Status w Shopify">
            <select className="input" name="status" defaultValue={sp.status ?? ""}>
              <option value="">Wszystkie</option>
              <option value="aktywny">Aktywne (widoczne w sklepie)</option>
              <option value="robocza">Wersje robocze</option>
            </select>
          </FilterField>
          <FilterField label="Używane">
            <select className="input" name="uzywane" defaultValue={sp.uzywane ?? ""}>
              <option value="">Wszystkie</option>
              <option value="tak">Tylko z tagiem reused</option>
            </select>
          </FilterField>
        </ListToolbar>
        <Pagination page={page} total={count ?? 0} perPage={PER_PAGE} params={listParams} top />
        <div className="card overflow-x-auto">
          <table className="table mtable mtable-flow">
            <thead><tr><th>Produkt</th><th>Sklepy</th><th>Rozmiary (stan w Shopify)</th></tr></thead>
            <tbody>
              {!data?.length && <tr><td colSpan={3} className="py-10 text-center text-muted">Brak produktów. Uruchom import z Shopify.</td></tr>}
              {data?.map((p) => {
                const variants = (p.variants as { id: string; option: string; position: number; links: { store_id: string; sku: string | null; shopify_qty: number | null }[] }[])
                  .sort((a, b) => collator.compare(a.option, b.option));
                const links = p.stores as { store_id: string; status: string | null; tags: string[] | null }[];
                const draft = links.length > 0 && links.every((l) => (l.status ?? "").toUpperCase() === "DRAFT");
                const reused = links.some((l) => (l.tags ?? []).some((t) => t.toLowerCase() === "reused"));
                return (
                  <tr key={p.id}>
                    <td className="m-full">
                      <div className="flex items-center gap-3">
                        <Thumb src={p.image_url} alt="" />
                        <span>
                          <span className="block font-medium leading-tight">{p.title}{reused && <span className="ml-1.5 align-middle"><Pill tone="amber">reused</Pill></span>}{draft && <span className="ml-1.5 align-middle"><Pill>wersja robocza</Pill></span>}</span>
                          <span className="text-xs text-muted">{p.style_sku ?? "bez SKU"}</span>
                        </span>
                      </div>
                    </td>
                    <td className="whitespace-nowrap text-xs max-md:hidden">{[...new Set(links.map((s) => storeName.get(s.store_id)))].join(", ")}</td>
                    <td className="m-full max-md:pl-[3.25rem]">
                      <div className="flex flex-wrap gap-1">
                        {variants.map((v) => (
                          <Link key={v.id} href={`/magazyn?q=${encodeURIComponent(p.title)}`} title={v.links.map((l) => l.sku).filter(Boolean).join(", ") || undefined}
                            className="rounded-md border border-line px-1.5 py-0.5 text-xs hover:border-accent">
                            {v.option} <b>{shopQty(v.links)}</b>
                          </Link>
                        ))}
                      </div>
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
}

/** Własne produkty: „Dodaj produkt” (np. Renowacja obuwia) – w Kasie po nazwie albo kodzie, stan liczony albo nie. */
async function OwnProducts({ fiscal, edit }: { fiscal: FiscalSettings; edit?: string }) {
  const { supabase } = await requireProfile();
  const { data, error } = await supabase.from("pos_products").select("id, name, price, ptu, track_stock, stock, code, active, created_at").order("active", { ascending: false }).order("name");
  if (error) return <Notice tone="error">Uruchom migrację 0037 w Supabase (SQL Editor) – wtedy dodasz własne produkty.</Notice>;
  const editing = (data ?? []).find((p) => p.id === edit);
  const Form = ({ p }: { p?: typeof editing }) => (
    <form action={saveOwnProduct} className="card space-y-4 p-5">
      <h2 className="h2">{p ? `Zmień: ${p.name}` : "Dodaj produkt"}</h2>
      {p && <input type="hidden" name="id" value={p.id} />}
      <div className="grid gap-3 md:grid-cols-[1fr_9rem_11rem_10rem]">
        <div><label className="label" htmlFor="own-name">Nazwa (na paragonie)</label><input id="own-name" className="input" name="name" defaultValue={p?.name ?? ""} placeholder="np. Renowacja obuwia" required maxLength={120} /></div>
        <div><label className="label" htmlFor="own-price">Cena (zł)</label><input id="own-price" className="input tabular-nums" name="price" inputMode="decimal" defaultValue={p?.price ?? ""} placeholder="np. 120" /></div>
        <div><label className="label" htmlFor="own-ptu">Stawka PTU</label>
          <select id="own-ptu" className="input" name="ptu" defaultValue={p?.ptu ?? fiscal.ptu23}>{PTU_LETTERS.map((l) => <option key={l} value={l}>{ptuLabel(fiscal, l)}</option>)}</select>
        </div>
        <div><label className="label" htmlFor="own-code">Kod (opcjonalnie)</label><input id="own-code" className="input font-mono uppercase" name="code" defaultValue={p?.code ?? ""} placeholder="EAN / własny" /></div>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="track_stock" value="1" defaultChecked={p?.track_stock ?? false} /> Licz stan magazynowy</label>
        <label className="flex items-center gap-2 text-sm">Stan: <input className="input w-24 tabular-nums" name="stock" type="number" min={0} defaultValue={p?.stock ?? 0} aria-label="Stan" /></label>
        <span className="text-xs text-muted">Bez liczenia stanu (np. usługa) produkt można sprzedawać bez ograniczeń.</span>
      </div>
      <div className="flex gap-2">
        <SubmitButton pendingText="Zapisuję…">{p ? "Zapisz" : "Dodaj produkt"}</SubmitButton>
        {p && <Link className="btn-secondary" href="/katalog?widok=wlasne">Anuluj</Link>}
      </div>
    </form>
  );
  return (
    <div className="space-y-5">
      <Form p={editing} />
      <div className="card overflow-x-auto">
        <table className="table mtable mtable-flow">
          <thead><tr><th>Produkt</th><th>Kod</th><th className="text-right">Cena</th><th>PTU</th><th>Stan</th><th /></tr></thead>
          <tbody>
            {!data?.length && <tr><td colSpan={6} className="py-8 text-center text-muted">Brak własnych produktów. Dodaj pierwszy powyżej albo zaznacz „zapisz jako własny produkt” w Kasie.</td></tr>}
            {data?.map((p) => (
              <tr key={p.id} className={p.active ? "" : "opacity-50"}>
                <td className="m-full font-medium">{p.name}{!p.active && <span className="ml-2"><Pill>ukryty</Pill></span>}</td>
                <td className="font-mono text-xs">{p.code ?? "–"}</td>
                <td className="text-right tabular-nums">{p.price !== null ? money(p.price) : "–"}</td>
                <td className="text-sm">{ptuLabel(fiscal, p.ptu)}</td>
                <td className="text-sm">{p.track_stock ? <b className={p.stock > 0 ? "" : "text-bad"}>{p.stock} szt.</b> : <span className="text-muted">nie liczony</span>}</td>
                <td>
                  <div className="flex justify-end gap-1">
                    <Link className="btn-ghost h-8 px-2 text-xs" href={`/katalog?widok=wlasne&edytuj=${p.id}`}>Zmień</Link>
                    <form action={toggleOwnProduct}><input type="hidden" name="id" value={p.id} /><input type="hidden" name="active" value={p.active ? "0" : "1"} /><button className="btn-ghost h-8 px-2 text-xs">{p.active ? "Ukryj" : "Przywróć"}</button></form>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
