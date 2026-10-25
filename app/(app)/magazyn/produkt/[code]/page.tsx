import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { money, UNIT_STATUS } from "@/lib/labels";
import { parseProductTagCode, productTagCode } from "@/lib/price-tag-code";
import { PageHeader } from "@/components/ui";
import { withoutMirrors } from "@/lib/stores";

export const metadata = { title: "Stan produktu" };

/** Stan produktu po zeskanowaniu metki produktu (PR…): dostępne rozmiary, ceny w sklepach i gdzie leżą sztuki. */
export default async function ProductStockPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const no = parseProductTagCode(decodeURIComponent(code));
  if (no === null) notFound();
  const { supabase } = await requireProfile();
  const { data: p } = await supabase.from("products").select("id, title, style_sku, image_url, tag_no").eq("tag_no", no).maybeSingle();
  if (!p) notFound();
  const [{ data: variants }, { data: stores }] = await Promise.all([
    supabase.from("variants").select("id, option, position, links:variant_store_links(store_id, price)").eq("product_id", p.id),
    supabase.from("stores").select("*").order("name").then(withoutMirrors),
  ]);
  const vids = (variants ?? []).map((v) => v.id as string);
  const { data: units } = vids.length
    ? await supabase.from("units").select("id, code, status, shelf, variant_id, location:locations(name, store_id)").in("variant_id", vids).in("status", ["in_stock", "reserved", "in_transit"]).order("number")
    : { data: [] };
  type U = { id: string; code: string; status: string; shelf: string | null; variant_id: string; location: { name: string; store_id: string } };
  const list = (units ?? []) as unknown as U[];
  const collator = new Intl.Collator("pl", { numeric: true });
  const sizes = ((variants ?? []) as { id: string; option: string; position: number | null; links: { store_id: string; price: number | null }[] }[])
    .map((v) => ({ ...v, units: list.filter((u) => u.variant_id === v.id) }))
    .sort((a, b) => collator.compare(a.option, b.option));
  const storeList = (stores ?? []) as { id: string; name: string }[];
  const available = sizes.filter((s) => s.units.some((u) => u.status === "in_stock"));

  return (
    <>
      <PageHeader
        back="/magazyn/produkty"
        title={p.title as string}
        sub={<><span className="font-mono">{productTagCode(p.tag_no as number)}</span>{p.style_sku ? ` · ${p.style_sku}` : ""} · {available.length ? `dostępne rozmiary: ${available.map((s) => s.option).join(", ")}` : "brak na stanie"}</>}
        actions={<><Link className="btn-secondary" href={`/magazyn/produkty?q=${encodeURIComponent((p.style_sku as string | null) ?? (p.title as string))}`}>Metka produktu</Link><Link className="btn-secondary" href="/magazyn">Magazyn</Link></>}
      />
      <div className="grid gap-4 lg:grid-cols-[14rem_1fr]">
        {p.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`${p.image_url}${(p.image_url as string).includes("?") ? "&" : "?"}width=480`} alt="" className="w-full max-w-56 rounded-xl border border-line bg-white object-contain" />
        ) : <div className="hidden lg:block" />}
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {sizes.map((s) => {
            const inStock = s.units.filter((u) => u.status === "in_stock");
            return (
              <div key={s.id} className={`card p-3 ${inStock.length ? "border-emerald-300" : "opacity-60"}`}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-2xl font-bold">{s.option}</span>
                  <span className={`text-sm font-semibold ${inStock.length ? "text-ok" : "text-muted"}`}>{inStock.length ? `${inStock.length} szt.` : "brak"}</span>
                </div>
                <div className="mt-1 text-xs text-muted">
                  {storeList.map((st) => {
                    const price = s.links.find((l) => l.store_id === st.id)?.price;
                    const n = inStock.filter((u) => u.location.store_id === st.id).length;
                    return price != null || n ? <span key={st.id} className="mr-2 inline-block">{st.name}: {price != null ? money(Number(price)) : "–"}{n ? ` · ${n} szt.` : ""}</span> : null;
                  })}
                </div>
                {s.units.length > 0 && (
                  <ul className="mt-2 space-y-0.5 text-xs">
                    {s.units.map((u) => (
                      <li key={u.id}><Link className="font-mono text-accent hover:underline" href={`/magazyn/${u.id}`}>{u.code}</Link> · {u.location.name}{u.shelf ? ` · półka ${u.shelf}` : ""}{u.status !== "in_stock" ? ` · ${UNIT_STATUS[u.status as keyof typeof UNIT_STATUS] ?? u.status}` : ""}</li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
