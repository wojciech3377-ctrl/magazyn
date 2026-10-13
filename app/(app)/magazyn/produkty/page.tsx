import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { findVariantIds } from "@/lib/queries/units";
import { parseProductTagCode, productTagCode } from "@/lib/price-tag-code";
import { redirect } from "next/navigation";
import { defaultOrderStore } from "@/lib/orders/default-store";
import { PageHeader, Thumb } from "@/components/ui";
import { SearchInput } from "@/components/SearchInput";
import { ProductTagsForm, type ProductRow } from "./ProductTagsForm";

export const metadata = { title: "Stan produktu + metka" };

/**
 * Metki produktów z katalogu: jeden produkt = jedna metka (bez rozmiaru), z kodem PR…, po którego zeskanowaniu
 * aplikacja pokazuje stan produktu i dostępne rozmiary. Wyszukiwanie, zaznacz wszystko, wydruk metek.
 */
export default async function ProductTagsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { supabase } = await requireProfile();
  const db = createAdminClient();
  const { data: stores } = await supabase.from("stores").select("id, name").order("name");
  const storeList = (stores ?? []) as { id: string; name: string }[];
  const storeId = storeList.some((s) => s.id === sp.sklep) ? sp.sklep! : await defaultOrderStore(db, storeList);
  if (sp.q && parseProductTagCode(sp.q) !== null) redirect(`/magazyn/produkt/${encodeURIComponent(sp.q.trim().toUpperCase())}`);
  const q = (sp.q ?? "").trim().replace(/[,()*%\\]/g, " ").trim().slice(0, 80);
  const tylkoNaStanie = sp.wszystkie !== "1";

  // Produkty: wyszukane (nazwa, SKU, EAN) albo – bez wyszukiwania – te, które mają sztuki na stanie w sklepie.
  let productIds: string[] = [];
  if (q.length >= 2) {
    const vids = await findVariantIds(supabase, q);
    const { data } = vids.length ? await supabase.from("variants").select("product_id").in("id", vids.slice(0, 500)) : { data: [] };
    productIds = [...new Set((data ?? []).map((v) => v.product_id as string))];
  }
  const { data: stock } = await supabase.from("units").select("variant:variants(product_id), location:locations(store_id)")
    .eq("status", "in_stock").limit(20000);
  const inStore = new Map<string, number>();
  const anywhere = new Map<string, number>();
  for (const u of (stock ?? []) as unknown as { variant: { product_id: string }; location: { store_id: string } }[]) {
    anywhere.set(u.variant.product_id, (anywhere.get(u.variant.product_id) ?? 0) + 1);
    if (u.location.store_id === storeId) inStore.set(u.variant.product_id, (inStore.get(u.variant.product_id) ?? 0) + 1);
  }
  if (q.length < 2 && tylkoNaStanie) productIds = [...inStore.keys()];
  else if (q.length < 2) {
    // Wszystkie produkty sklepu (bez wyszukiwania – pierwsze 300 alfabetycznie).
    const { data } = await supabase.from("product_store_links").select("product_id, product:products(title)").eq("store_id", storeId).limit(5000);
    productIds = ((data ?? []) as unknown as { product_id: string; product: { title: string } | null }[])
      .sort((a, b) => (a.product?.title ?? "").localeCompare(b.product?.title ?? "", "pl")).slice(0, 300).map((r) => r.product_id);
  }
  else if (tylkoNaStanie) productIds = productIds.filter((id) => (anywhere.get(id) ?? 0) > 0);

  const rows: ProductRow[] = [];
  for (let i = 0; i < productIds.length && i < 2000; i += 200) {
    const part = productIds.slice(i, i + 200);
    const { data } = await supabase.from("products").select("*, links:product_store_links(store_id)").in("id", part);
    for (const p of (data ?? []) as { id: string; title: string; style_sku: string | null; image_url: string | null; tag_no?: number | null; links: { store_id: string }[] }[]) {
      rows.push({
        id: p.id, title: p.title, sku: p.style_sku, image: p.image_url, code: p.tag_no ? productTagCode(p.tag_no) : null,
        inStore: inStore.get(p.id) ?? 0, total: anywhere.get(p.id) ?? 0, linked: p.links.some((l) => l.store_id === storeId),
      });
    }
  }
  rows.sort((a, b) => a.title.localeCompare(b.title, "pl"));
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
        <ProductTagsForm rows={rows} storeId={storeId} storeName={storeList.find((s) => s.id === storeId)?.name ?? ""} thumbs={Object.fromEntries(rows.map((r) => [r.id, r.image ? <Thumb src={r.image} alt="" /> : null]))} />
      )}
    </>
  );
}
