import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { findVariantIds } from "@/lib/queries/units";
import { parseProductTagCode, productTagCode } from "@/lib/price-tag-code";
import { redirect } from "next/navigation";
import { pickDefaultStore } from "@/lib/orders/default-store";
import { PageHeader, Thumb } from "@/components/ui";
import { SearchInput } from "@/components/SearchInput";
import { ProductTagsForm, type ProductRow } from "./ProductTagsForm";

export const metadata = { title: "Stan produktu + metka" };

const MAX_ROWS = 3000;

/** Wszystkie wiersze zapytania, po 1000 (limit Supabase na jedno zapytanie). */
async function allPages<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null }>, max = 100_000) {
  const out: T[] = [];
  for (let from = 0; from < max; from += 1000) {
    const { data } = await page(from, from + 999);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

/**
 * Metki produktów z katalogu: jeden produkt = jedna metka (bez rozmiaru), z kodem PR…, po którego zeskanowaniu
 * aplikacja pokazuje stan produktu i dostępne rozmiary. Wyszukiwanie, zaznacz wszystko, wydruk metek.
 */
export default async function ProductTagsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { supabase } = await requireProfile();
  const db = createAdminClient();
  const [{ data: stores }, { data: ordersCfg }] = await Promise.all([
    supabase.from("stores").select("id, name").order("name"),
    db.from("app_settings").select("value").eq("key", "orders").maybeSingle(),
  ]);
  const storeList = (stores ?? []) as { id: string; name: string }[];
  const storeId = storeList.some((s) => s.id === sp.sklep) ? sp.sklep! : pickDefaultStore(ordersCfg?.value, storeList);
  if (sp.q && parseProductTagCode(sp.q) !== null) redirect(`/magazyn/produkt/${encodeURIComponent(sp.q.trim().toUpperCase())}`);
  const q = (sp.q ?? "").trim().replace(/[,()*%\\]/g, " ").trim().slice(0, 80);
  const tylkoNaStanie = sp.wszystkie !== "1";

  // Produkty: wyszukane (nazwa, SKU, EAN) albo – bez wyszukiwania – te, które mają sztuki na stanie.
  // Supabase oddaje najwyżej 1000 wierszy naraz, więc stany i listy czytamy stronami.
  // Wyszukiwanie, stany i produkty sklepu – równolegle.
  async function searchIds() {
    let byTitle = supabase.from("products").select("id").limit(1000);
    for (const w of q.split(/\s+/).filter(Boolean).slice(0, 5)) byTitle = byTitle.ilike("title", `%${w}%`);
    const [{ data: titled }, vids] = await Promise.all([byTitle, findVariantIds(supabase, q)]);
    const ids = new Set((titled ?? []).map((p) => p.id as string));
    const parts = await Promise.all(Array.from({ length: Math.ceil(Math.min(vids.length, 2000) / 300) }, (_, i) =>
      supabase.from("variants").select("product_id").in("id", vids.slice(i * 300, i * 300 + 300))));
    for (const { data } of parts) for (const v of data ?? []) ids.add(v.product_id as string);
    return [...ids];
  }
  type StockRow = { variant: { product_id: string } | null; location: { store_id: string } | null };
  type LinkRow = { product_id: string };
  const [found, stock, links] = await Promise.all([
    q.length >= 2 ? searchIds() : Promise.resolve([] as string[]),
    allPages<StockRow>((from, to) =>
      supabase.from("units").select("variant:variants(product_id), location:locations(store_id)").eq("status", "in_stock").order("id").range(from, to) as unknown as PromiseLike<{ data: StockRow[] | null }>),
    // Produkty sklepu (do „brak w tym sklepie” i listy bez sztuk na stanie).
    allPages<LinkRow>((from, to) =>
      supabase.from("product_store_links").select("product_id").eq("store_id", storeId).order("product_id").range(from, to) as unknown as PromiseLike<{ data: LinkRow[] | null }>),
  ]);
  let productIds: string[] = found;
  const inStore = new Map<string, number>();
  const anywhere = new Map<string, number>();
  for (const u of stock) {
    if (!u.variant) continue;
    anywhere.set(u.variant.product_id, (anywhere.get(u.variant.product_id) ?? 0) + 1);
    if (u.location?.store_id === storeId) inStore.set(u.variant.product_id, (inStore.get(u.variant.product_id) ?? 0) + 1);
  }
  const linkedIds = new Set(links.map((l) => l.product_id));
  let capped = false;
  if (q.length < 2 && tylkoNaStanie) {
    // Na stanie: sztuki w lokalizacjach tego sklepu albo produkt tego sklepu ze sztukami gdziekolwiek.
    productIds = [...anywhere.keys()].filter((id) => inStore.has(id) || linkedIds.has(id));
  } else if (q.length < 2) {
    productIds = [...new Set([...linkedIds, ...anywhere.keys()])];
    capped = productIds.length > MAX_ROWS;
  } else if (tylkoNaStanie) productIds = productIds.filter((id) => (anywhere.get(id) ?? 0) > 0);

  const rows: ProductRow[] = [];
  const chunks = await Promise.all(Array.from({ length: Math.ceil(productIds.length / 200) }, (_, i) =>
    supabase.from("products").select("*").in("id", productIds.slice(i * 200, i * 200 + 200))));
  for (const { data } of chunks) {
    for (const p of (data ?? []) as { id: string; title: string; style_sku: string | null; image_url: string | null; tag_no?: number | null }[]) {
      rows.push({
        id: p.id, title: p.title, sku: p.style_sku, image: p.image_url, code: p.tag_no ? productTagCode(p.tag_no) : null,
        inStore: inStore.get(p.id) ?? 0, total: anywhere.get(p.id) ?? 0, linked: linkedIds.has(p.id),
      });
    }
  }
  rows.sort((a, b) => a.title.localeCompare(b.title, "pl"));
  if (rows.length > MAX_ROWS) rows.length = MAX_ROWS;
  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams(Object.entries({ q: sp.q, sklep: storeId, wszystkie: sp.wszystkie, ...patch }).filter((e): e is [string, string] => !!e[1]));
    return `/magazyn/produkty?${p}`;
  };

  return (
    <>
      <PageHeader
        title="Stan produktu + metka"
        sub="Jedna metka na produkt (bez rozmiaru). Kod PR… na metce po zeskanowaniu pokazuje stan produktu i dostępne rozmiary."
        actions={<Link className="btn-secondary" href="/magazyn">Wróć do magazynu</Link>}
      />
      <form className="card mb-4 flex flex-wrap items-end gap-3 p-4" method="get">
        <div className="min-w-64 flex-1">
          <label className="label" htmlFor="q">Szukaj produktu</label>
          <SearchInput id="q" name="q" defaultValue={sp.q ?? ""} placeholder="Nazwa, SKU, EAN albo kod PR…" />
        </div>
        <div>
          <label className="label" htmlFor="sklep">Sklep (cena na metce)</label>
          <select id="sklep" name="sklep" className="input w-48" defaultValue={storeId}>{storeList.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm text-muted"><input type="checkbox" name="wszystkie" value="1" defaultChecked={!tylkoNaStanie} /> także bez sztuk na stanie</label>
        <button className="btn">Szukaj</button>
      </form>
      {!rows.length ? (
        <p className="card p-8 text-center text-sm text-muted">{q.length >= 2 ? `Nie znaleziono „${q}”.` : "Brak produktów ze sztukami na stanie w tym sklepie."} <Link className="text-accent hover:underline" href={qs({ wszystkie: "1" })}>Pokaż wszystkie</Link></p>
      ) : (
        <>
        {capped && <p className="mb-3 text-sm text-muted">Pokazano pierwsze {MAX_ROWS} produktów alfabetycznie – wpisz nazwę albo SKU, żeby zawęzić listę.</p>}
        <ProductTagsForm rows={rows} storeId={storeId} storeName={storeList.find((s) => s.id === storeId)?.name ?? ""} thumbs={Object.fromEntries(rows.map((r) => [r.id, r.image ? <Thumb src={r.image} alt="" /> : null]))} />
        </>
      )}
    </>
  );
}
