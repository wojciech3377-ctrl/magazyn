import { searchWords, wordsOr } from "@/lib/search";
import Link from "next/link";
import { SearchInput } from "@/components/SearchInput";
import { notFound, redirect } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { dateOnly, money } from "@/lib/labels";
import { Notice, PageHeader } from "@/components/ui";
import { VariantPick } from "@/components/VariantPick";
import { attachExistingContract } from "../actions";

export const metadata = { title: "Dołącz umowę" };

const UUID = /^[0-9a-f-]{36}$/;

/**
 * „Dołącz umowę” do sprzedanej rzeczy: gotowa (niewykorzystana) umowa z listy, nowa umowa do podpisu (link)
 * albo skan papierowej umowy.
 */
export default async function AttachContractPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { supabase } = await requireProfile();
  const saleId = sp.sprzedaz && UUID.test(sp.sprzedaz) ? sp.sprzedaz : null;
  const unitParam = !saleId && sp.sztuka && UUID.test(sp.sztuka) ? sp.sztuka : null;
  if (!saleId && !unitParam) notFound();
  const back = (sp.back?.startsWith("/sprzedaz") || sp.back?.startsWith("/magazyn")) && !sp.back.startsWith("//") ? sp.back : "/sprzedaz";

  type U = { id: string; code: string; owner_type: string; contract_id: string | null; status: string; consignor: { id: string; name: string } | null; variant: { option: string; product: { title: string } } | null };
  const UNIT = "id, code, owner_type, contract_id, status, consignor:consignors(id, name), variant:variants(option, product:products(title))";
  let unit: U | null = null;
  type S = { id: string; order_ref: string | null; order_id: string | null; store_id: string | null; variant_id: string | null; product_name: string | null; status: string; variant: U["variant"] };
  let sale: S | null = null;
  if (saleId) {
    const { data } = await supabase.from("sales").select(`id, order_ref, order_id, store_id, variant_id, product_name, status, variant:variants(option, product:products(title)), unit:units(${UNIT})`).eq("id", saleId).maybeSingle();
    if (!data) notFound();
    sale = data as unknown as S;
    unit = (data.unit as unknown as U | null) ?? null;
  } else {
    const { data } = await supabase.from("units").select(UNIT).eq("id", unitParam!).maybeSingle();
    if (!data) notFound();
    unit = data as unknown as U;
  }
  // Umowa już jest (albo w toku) – pokaż ją.
  if (unit?.contract_id) redirect(`/umowy/${unit.contract_id}`);
  if (saleId) {
    const { data: pending } = await supabase.from("contracts").select("id").eq("sale_id", saleId).not("status", "in", "(cancelled,rejected)").limit(1).maybeSingle();
    if (pending) redirect(`/umowy/${pending.id}`);
  }

  const variant = unit?.variant ?? sale?.variant ?? null;
  const name = variant ? `${variant.product.title} · ${variant.option}` : sale?.product_name ?? "przedmiot";
  const needsVariant = !!sale && !unit && !sale.variant_id;
  const templateHref = unit ? `/umowy/z-szablonu?ids=${unit.id}` : `/umowy/z-szablonu?sprzedaz=${saleId}`;
  const scanHref = unit ? `/umowy/nowa?ids=${unit.id}` : `/umowy/nowa?sprzedaz=${saleId}`;

  // Gotowe umowy: niewykorzystane (żadna rzecz z nimi nie jest w magazynie), nieprzypisane do innej sprzedaży.
  const q = (sp.q ?? "").replace(/[%,()*\\]/g, " ").trim();
  let query = supabase.from("contract_overview_unused").select("id, number, counterparty, amount, currency, contract_date, created_at, status, template, items")
    .order("created_at", { ascending: false }).limit(60);
  const qex = wordsOr(["counterparty", "items_text"], searchWords(q), /^\d+$/.test(q) ? [`number.eq.${q}`] : []);
  if (q && qex) query = query.or(qex);
  const { data: candidates } = await query;
  const ids = (candidates ?? []).map((c) => c.id as string);
  const { data: bound } = ids.length ? await supabase.from("contracts").select("id, sale_id, doc_number").in("id", ids) : { data: [] };
  const boundTo = new Map((bound ?? []).map((b) => [b.id as string, b]));
  const list = (candidates ?? []).filter((c) => {
    const b = boundTo.get(c.id as string);
    return !b?.sale_id || b.sale_id === saleId;
  });
  // Umowy „kwota za każdą rzecz” (bez pozycji), które mają już rzeczy – obejmują kilka rzeczy w tej samej cenie,
  // więc można je dołączać do kolejnych sprzedaży.
  const usedCount = new Map<string, number>();
  {
    let pq = supabase.from("contracts").select("id, number, counterparty, amount, currency, contract_date, created_at, status, template, items, doc_number, sale_id")
      .eq("amount_per_item", true).eq("status", "accepted").order("created_at", { ascending: false }).limit(60);
    const pex = wordsOr(["counterparty", "doc_number"], searchWords(q), /^\d+$/.test(q) ? [`number.eq.${q}`] : []);
    if (q && pex) pq = pq.or(pex);
    const { data: per } = await pq.then((r) => r, () => ({ data: [] }));
    const known = new Set(list.map((c) => c.id as string));
    type PerRow = (typeof list)[number] & { doc_number: string | null; sale_id: string | null };
    const more = ((per ?? []) as PerRow[])
      .filter((c) => !known.has(c.id as string) && !((c.items ?? []) as unknown[]).length && (!c.sale_id || c.sale_id === saleId));
    if (more.length) {
      const { data: us } = await supabase.from("units").select("contract_id").in("contract_id", more.map((c) => c.id as string)).not("status", "in", "(removed,consignor_returned)");
      for (const u of us ?? []) usedCount.set(u.contract_id as string, (usedCount.get(u.contract_id as string) ?? 0) + 1);
      for (const c of more) {
        if (!usedCount.has(c.id as string)) continue;
        boundTo.set(c.id as string, { id: c.id, sale_id: c.sale_id, doc_number: c.doc_number });
        list.push(c);
      }
    }
  }

  return (
    <>
      <PageHeader
        title="Dołącz umowę"
        sub={<>{name}{sale?.order_ref ? <> · zamówienie {sale.order_id ? <Link className="text-accent hover:underline" href={`/sprzedaz/${sale.order_id}`}>{sale.order_ref}</Link> : sale.order_ref}</> : null}{unit ? <> · sztuka <span className="font-mono">{unit.code}</span></> : null}</>}
        actions={<Link className="btn-secondary" href={back}>Wróć</Link>}
      />
      {sp.blad && <div className="mb-4"><Notice tone="error">{sp.blad}</Notice></div>}
      {unit?.owner_type === "consignment" && (
        <div className="mb-4">
          <Notice>Rzecz komisanta {unit.consignor ? <Link className="underline" href={`/komisanci/${unit.consignor.id}`}>{unit.consignor.name}</Link> : ""}. Komisant dołącza umowę albo fakturę w swoim panelu (dostaje e-mail po sprzedaży). Możesz też dołączyć ją tutaj.</Notice>
        </div>
      )}

      <div className="mb-6 grid gap-3 md:grid-cols-2">
        <Link href={templateHref} className="card block p-4 hover:border-accent">
          <span className="block font-medium">Utwórz umowę do podpisu</span>
          <span className="mt-1 block text-sm text-muted">Umowa z szablonu: sprzedający dostaje link, wpisuje dane i podpisuje. Do czasu zatwierdzenia i opłacenia przy zamówieniu widać „Umowa w toku”.</span>
        </Link>
        <Link href={scanHref} className="card block p-4 hover:border-accent">
          <span className="block font-medium">Wgraj skan papierowej umowy</span>
          <span className="mt-1 block text-sm text-muted">PDF albo zdjęcie podpisanej umowy.</span>
        </Link>
      </div>

      <h2 className="h2 mb-2">Dołącz gotową umowę</h2>
      <p className="mb-3 text-sm text-muted">Umowy zatwierdzone, do których nie ma jeszcze żadnej rzeczy w magazynie, oraz umowy „kwota za każdą rzecz” (jedna umowa na kilka rzeczy w tej samej cenie).</p>
      <form className="mb-3 flex flex-wrap gap-2" method="get">
        {saleId ? <input type="hidden" name="sprzedaz" value={saleId} /> : <input type="hidden" name="sztuka" value={unitParam!} />}
        <input type="hidden" name="back" value={back} />
        <SearchInput wrapperClassName="w-full sm:w-96" name="q" defaultValue={sp.q} placeholder="Sprzedający, produkt (nazwa, rozmiar) albo numer umowy" />
        <button className="btn">Szukaj</button>
        {variant && !q && (
          <Link className="btn-secondary" href={`/sprzedaz/umowa?${saleId ? `sprzedaz=${saleId}` : `sztuka=${unitParam}`}&back=${encodeURIComponent(back)}&q=${encodeURIComponent(variant.product.title.split(" ").slice(0, 4).join(" "))}`}>Pokaż umowy z „{variant.product.title.split(" ").slice(0, 4).join(" ")}”</Link>
        )}
      </form>
      <form action={attachExistingContract}>
      {saleId ? <input type="hidden" name="sale_id" value={saleId} /> : <input type="hidden" name="unit_id" value={unitParam!} />}
      <input type="hidden" name="back" value={back} />
      {needsVariant && (
        <div className="mb-3 max-w-xl">
          <Notice>Pozycja zamówienia nie jest powiązana z katalogiem. Wybierz produkt i rozmiar – umowa utworzy dla niego sprzedaną sztukę.</Notice>
          <div className="mt-2"><VariantPick name="variant_id" storeId={sale!.store_id ?? ""} label="Produkt z katalogu" /></div>
        </div>
      )}
      <div className="card overflow-x-auto">
        <table className="table mtable mtable-flow">
          <thead><tr><th>Numer</th><th>Sprzedający</th><th>Pozycje</th><th>Data</th><th className="text-right">Kwota</th><th /></tr></thead>
          <tbody>
            {!list.length && <tr><td colSpan={6} className="py-8 text-center text-muted">Brak niewykorzystanych umów{q ? " dla tego wyszukiwania" : ""}.</td></tr>}
            {list.map((c) => {
              const items = (c.items ?? []) as { title?: string; option?: string }[];
              const docNumber = boundTo.get(c.id as string)?.doc_number as string | null | undefined;
              return (
                <tr key={c.id}>
                  <td className="whitespace-nowrap"><Link className="text-accent hover:underline" href={`/umowy/${c.id}`} target="_blank">{docNumber ?? (c.number ? `NR${c.number}` : "bez numeru")}</Link></td>
                  <td>{c.counterparty}</td>
                  <td className="max-w-80 text-sm text-muted"><span className="line-clamp-2">{items.length ? items.map((i) => `${i.title ?? ""} ${i.option ?? ""}`.trim()).join(", ") : "–"}</span>{usedCount.has(c.id as string) && <span className="mt-0.5 block text-xs font-medium text-accent">kwota za każdą rzecz · już {usedCount.get(c.id as string)} szt.</span>}</td>
                  <td className="whitespace-nowrap text-sm text-muted">{dateOnly(c.contract_date ?? c.created_at)}</td>
                  <td className="whitespace-nowrap text-right tabular-nums">{c.amount !== null ? (c.currency && c.currency !== "PLN" ? `${Number(c.amount).toFixed(2)} ${c.currency}` : money(c.amount)) : "–"}</td>
                  <td><button className="btn-secondary px-2.5 py-1 text-xs" name="contract_id" value={c.id}>Dołącz</button></td>
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
