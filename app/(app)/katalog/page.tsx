import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { findVariantIds } from "@/lib/queries/units";
import { dateTime } from "@/lib/labels";
import { Notice, PageHeader, Pagination, Pill, Thumb } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { acceptAllSuggestions, setLink } from "./actions";
import { SyncPanel } from "./SyncPanel";

const PER_PAGE = 50;

export default async function KatalogPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { supabase, profile } = await requireProfile();
  const tab = sp.widok === "powiazania" ? "powiazania" : "produkty";
  const page = Math.max(1, Number(sp.strona ?? 1));
  const { data: stores } = await supabase.from("stores").select("id, name, shopify_domain, base_inventory_id, base_storage_id").order("name");
  const storeName = new Map((stores ?? []).map((s) => [s.id, s.name]));

  const [{ count: products }, { count: unlinked }, { count: suggested }, { data: linkErrors }] = await Promise.all([
    supabase.from("products").select("id", { count: "exact", head: true }),
    supabase.from("variant_store_links").select("id", { count: "exact", head: true }).is("base_product_id", null),
    supabase.from("variant_store_links").select("id", { count: "exact", head: true }).is("base_product_id", null).not("suggested_base_product_id", "is", null),
    supabase.from("sync_log").select("message, created_at").eq("job", "manual-link").eq("ok", false).gte("created_at", new Date(Date.now() - 2 * 60_000).toISOString()).order("created_at", { ascending: false }).limit(1),
  ]);

  return (
    <>
      <PageHeader title="Katalog" sub={`${products ?? 0} produktów z obu sklepów · ${unlinked ?? 0} rozmiarów bez powiązania z Base (${suggested ?? 0} z podpowiedzią)`} />
      {profile.role === "admin" && <SyncPanel stores={stores ?? []} />}
      {linkErrors?.[0] && <div className="mb-4"><Notice tone="error">{linkErrors[0].message}</Notice></div>}

      <div className="mb-4 flex gap-1 text-sm">
        <Link href="/katalog" className={`rounded-md px-3 py-1.5 ${tab === "produkty" ? "bg-ink text-white" : "text-muted hover:bg-panel"}`}>Produkty</Link>
        <Link href="/katalog?widok=powiazania" className={`rounded-md px-3 py-1.5 ${tab === "powiazania" ? "bg-ink text-white" : "text-muted hover:bg-panel"}`}>Bez powiązania z Base ({unlinked ?? 0})</Link>
      </div>

      {tab === "produkty" ? <Products sp={sp} page={page} /> : <Links sp={sp} page={page} storeName={storeName} stores={stores ?? []} isAdmin={profile.role === "admin"} />}
    </>
  );

  async function Products({ sp, page }: { sp: Record<string, string | undefined>; page: number }) {
    let query = supabase
      .from("products")
      .select("id, title, style_sku, image_url, updated_at, stores:product_store_links(store_id), variants(id, option, position, links:variant_store_links(store_id, base_product_id, base_sku))", { count: "exact" })
      .order("title")
      .range((page - 1) * PER_PAGE, page * PER_PAGE - 1);
    if (sp.q) {
      const ids = await findVariantIds(supabase, sp.q.replace(/[,()*%\\]/g, " ").trim());
      const { data: pids } = ids.length ? await supabase.from("variants").select("product_id").in("id", ids.slice(0, 150)) : { data: [] };
      query = query.in("id", [...new Set((pids ?? []).map((p) => p.product_id))].slice(0, 100).concat("00000000-0000-0000-0000-000000000000"));
    }
    const { data, count } = await query;
    const allVariantIds = (data ?? []).flatMap((p) => (p.variants as { id: string }[]).map((v) => v.id));
    const chunks = Array.from({ length: Math.ceil(allVariantIds.length / 100) }, (_, i) => allVariantIds.slice(i * 100, i * 100 + 100));
    const stock = (await Promise.all(chunks.map((c) => supabase.from("variant_stock_totals").select("variant_id, in_stock").in("variant_id", c))))
      .flatMap((r) => r.data ?? []);
    const counts = new Map(stock.map((s) => [s.variant_id as string, Number(s.in_stock)]));
    const collator = new Intl.Collator("pl", { numeric: true });

    return (
      <>
        <form className="mb-4 flex gap-2" method="get">
          <input className="input w-80" name="q" defaultValue={sp.q} placeholder="Szukaj: nazwa, SKU modelu, SKU z Base, EAN" />
          <button className="btn">Szukaj</button>
        </form>
        <div className="card overflow-x-auto">
          <table className="table">
            <thead><tr><th>Produkt</th><th>Sklepy</th><th>Rozmiary (sztuk na stanie)</th></tr></thead>
            <tbody>
              {!data?.length && <tr><td colSpan={3} className="py-10 text-center text-muted">Brak produktów. Uruchom import z Shopify.</td></tr>}
              {data?.map((p) => {
                const variants = (p.variants as { id: string; option: string; position: number; links: { store_id: string; base_product_id: number | null }[] }[])
                  .sort((a, b) => collator.compare(a.option, b.option));
                return (
                  <tr key={p.id}>
                    <td>
                      <div className="flex items-center gap-3">
                        <Thumb src={p.image_url} alt="" />
                        <span><span className="block font-medium leading-tight">{p.title}</span><span className="text-xs text-muted">{p.style_sku ?? "bez SKU"}</span></span>
                      </div>
                    </td>
                    <td className="whitespace-nowrap text-xs">{[...new Set((p.stores as { store_id: string }[]).map((s) => storeName.get(s.store_id)))].join(", ")}</td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {variants.map((v) => {
                          const missing = v.links.some((l) => !l.base_product_id);
                          return (
                            <Link key={v.id} href={`/magazyn?q=${encodeURIComponent(p.title)}`} title={missing ? "brak powiązania z Base" : "powiązany z Base"}
                              className={`rounded border px-1.5 py-0.5 text-xs ${missing ? "border-amber-300 bg-amber-50" : "border-line"}`}>
                              {v.option} <b>{counts.get(v.id) ?? 0}</b>
                            </Link>
                          );
                        })}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Pagination page={page} total={count ?? 0} perPage={PER_PAGE} params={{ q: sp.q }} />
      </>
    );
  }
}

async function Links({ sp, page, storeName, stores, isAdmin }: {
  sp: Record<string, string | undefined>; page: number; storeName: Map<string, string>; stores: { id: string; name: string }[]; isAdmin: boolean;
}) {
  const { supabase } = await requireProfile();
  let query = supabase
    .from("variant_store_links")
    .select("id, store_id, sku, shopify_variant_id, suggested_base_product_id, suggested_reason, updated_at, variant:variants!inner(option, product:products!inner(title, style_sku, image_url))", { count: "exact" })
    .is("base_product_id", null)
    .order("suggested_base_product_id", { ascending: true, nullsFirst: false })
    .range((page - 1) * PER_PAGE, page * PER_PAGE - 1);
  if (sp.sklep) query = query.eq("store_id", sp.sklep);
  const { data, count } = await query;

  const suggestionIds = (data ?? []).map((l) => l.suggested_base_product_id).filter(Boolean) as number[];
  const { data: suggestions } = suggestionIds.length
    ? await supabase.from("base_products").select("id, name, variant_name, sku").in("id", suggestionIds)
    : { data: [] };
  const sug = new Map((suggestions ?? []).map((s) => [Number(s.id), s]));

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <form method="get" className="flex gap-2">
          <input type="hidden" name="widok" value="powiazania" />
          <select className="input w-56" name="sklep" defaultValue={sp.sklep ?? ""}>
            <option value="">Oba sklepy</option>
            {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <button className="btn-secondary">Pokaż</button>
        </form>
        {isAdmin && stores.map((s) => (
          <form key={s.id} action={acceptAllSuggestions}>
            <input type="hidden" name="store_id" value={s.id} />
            <SubmitButton className="btn-secondary" pendingText="Zatwierdzam…">Zatwierdź wszystkie podpowiedzi: {s.name}</SubmitButton>
          </form>
        ))}
      </div>
      <p className="mb-3 text-sm text-muted">Te rozmiary nie mają odpowiednika w Base, więc przyjęcie dostawy nie podniesie ich stanu. Zatwierdź podpowiedź albo wpisz SKU lub ID produktu z Base.</p>
      <div className="card overflow-x-auto">
        <table className="table">
          <thead><tr><th>Produkt</th><th>Rozmiar</th><th>Sklep</th><th>Podpowiedź z Base</th><th>Przypisz ręcznie</th></tr></thead>
          <tbody>
            {!data?.length && <tr><td colSpan={5} className="py-10 text-center text-muted">Wszystkie rozmiary są powiązane z Base.</td></tr>}
            {data?.map((l) => {
              const v = l.variant as unknown as { option: string; product: { title: string; style_sku: string | null; image_url: string | null } };
              const s = l.suggested_base_product_id ? sug.get(Number(l.suggested_base_product_id)) : null;
              return (
                <tr key={l.id}>
                  <td><div className="flex items-center gap-3"><Thumb src={v.product.image_url} alt="" /><span><span className="block leading-tight">{v.product.title}</span><span className="text-xs text-muted">{v.product.style_sku}</span></span></div></td>
                  <td className="font-medium">{v.option}</td>
                  <td className="whitespace-nowrap">{storeName.get(l.store_id)}</td>
                  <td>
                    {s ? (
                      <form action={setLink} className="flex items-center gap-2">
                        <input type="hidden" name="link_id" value={l.id} />
                        <span className="text-xs">{s.name} · <b>{s.variant_name}</b><span className="block text-muted">SKU {s.sku ?? "–"} · {l.suggested_reason}</span></span>
                        <SubmitButton className="btn-secondary px-2 py-1 text-xs" name="accept" value="1" pendingText="…">Zatwierdź</SubmitButton>
                      </form>
                    ) : <Pill tone="amber">brak</Pill>}
                  </td>
                  <td>
                    <form action={setLink} className="flex items-center gap-1.5">
                      <input type="hidden" name="link_id" value={l.id} />
                      <input className="input w-36 py-1 text-xs" name="base" placeholder="SKU lub ID z Base" aria-label="SKU lub ID z Base" />
                      <SubmitButton className="btn-secondary px-2 py-1 text-xs" pendingText="…">Zapisz</SubmitButton>
                    </form>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Pagination page={page} total={count ?? 0} perPage={PER_PAGE} params={{ widok: "powiazania", sklep: sp.sklep }} />
      <p className="mt-2 text-xs text-muted">Ostatnia aktualizacja listy: {dateTime(new Date().toISOString())}</p>
    </>
  );
}
