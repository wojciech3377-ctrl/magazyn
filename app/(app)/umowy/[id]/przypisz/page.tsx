import { searchWords, wordsOr } from "@/lib/search";
import Link from "next/link";
import { SearchInput } from "@/components/SearchInput";
import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { dateTime, money, UNIT_STATUS } from "@/lib/labels";
import { Notice, PageHeader } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { matchPieces } from "@/lib/orders/pieces";
import type { LineItem } from "@/lib/sync/shop-orders";
import { assignContractToPiece, assignContractToUnit, detachUnit } from "../../actions";

/** Przypisanie umowy (np. bez rzeczy) do sztuki w magazynie / sprzedanej sztuki albo do pozycji zamówienia. */
export default async function AssignContractPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const { supabase } = await requireProfile();
  const { data: c } = await supabase.from("contracts").select("id, number, counterparty, amount, contract_date, items").eq("id", id).maybeSingle();
  if (!c) notFound();
  const source = sp.zrodlo === "sprzedaz" ? "sprzedaz" : "magazyn";
  const q = (sp.q ?? "").replace(/[%,()*\\]/g, " ").trim();

  let units: { id: string; code: string; title: string; option: string; status: string; identifier: string | null; location_name: string; received_at: string; sold_at: string | null }[] = [];
  let orders: { id: string; name: string; ordered_at: string; customer_name: string | null; line_items: LineItem[]; store: { name: string } | null }[] = [];
  let piecesOf = new Map<string, ReturnType<typeof matchPieces>>();
  if (source === "magazyn") {
    let query = supabase.from("units_list").select("id, code, title, option, status, identifier, location_name, received_at, sold_at")
      .is("contract_id", null).eq("owner_type", "own").in("status", ["in_stock", "reserved", "in_transit", "sold", "shipped"])
      .order("received_at", { ascending: false }).limit(60);
    const ex = wordsOr(["title", "code", "identifier", "style_sku", "base_sku", "option"], searchWords(q));
    if (ex) query = query.or(ex);
    units = ((await query).data ?? []) as typeof units;
  } else {
    let query = supabase.from("orders").select("id, name, ordered_at, customer_name, line_items, store:stores(name)").is("cancelled_at", null).order("ordered_at", { ascending: false }).limit(40);
    const ex = wordsOr(["number", "customer_name", "email"], searchWords(q.replace(/^#/, "")));
    if (ex) query = query.or(ex);
    orders = ((await query).data ?? []) as unknown as typeof orders;
    const ids = orders.map((o) => o.id);
    const [{ data: sales }, { data: links }] = await Promise.all([
      ids.length ? supabase.from("sales").select("id, order_id, status, variant_id, shopify_line_id, shopify_line_index, unit:units(id, contract_id)").in("order_id", ids) : Promise.resolve({ data: [] }),
      supabase.from("variant_store_links").select("variant_id, shopify_variant_id").in("shopify_variant_id", [...new Set(orders.flatMap((o) => o.line_items.map((l) => l.shopify_variant_id).filter((x): x is string => !!x)))].slice(0, 300)),
    ]);
    const variantOf = new Map((links ?? []).map((l) => [l.shopify_variant_id as string, l.variant_id as string]));
    piecesOf = new Map(orders.map((o) => [o.id, matchPieces(o.id, o.line_items, ((sales ?? []) as unknown as { order_id: string; id: string; status: string; variant_id: string | null; shopify_line_id: string | null; shopify_line_index: number | null; unit: { id: string; contract_id: string | null } | null }[]).filter((s) => s.order_id === o.id), (g) => variantOf.get(g))
      .filter((p) => p.sale?.status !== "cancelled" && !(p.sale as { unit?: { contract_id: string | null } | null } | null)?.unit?.contract_id)]));
  }
  const items = (c.items ?? []) as { title: string; option: string }[];
  const { data: attached } = await supabase.from("units_list").select("id, code, title, option, status, sold_at, received_at").eq("contract_id", c.id).order("received_at");

  return (
    <>
      <PageHeader
        title={`Przypisz umowę ${c.number ? `nr ${c.number}` : ""} · ${c.counterparty}`}
        sub={<>{items.length ? items.map((i) => `${i.title} ${i.option}`).join(", ") : "umowa bez pozycji"}{c.amount !== null ? ` · ${money(c.amount)}` : ""}</>}
        actions={<Link className="btn-secondary" href={`/umowy/${c.id}`}>Wróć do umowy</Link>}
      />
      {sp.blad && <div className="mb-4"><Notice tone="error">{sp.blad}</Notice></div>}
      {sp.ok && <div className="mb-4"><Notice tone="ok">{sp.ok}</Notice></div>}
      <section className="card mb-5 p-4">
        <h2 className="h2 mb-2">Przypisane do tej umowy</h2>
        {!attached?.length ? <p className="text-sm text-muted">Umowa nie jest przypisana do żadnej rzeczy – jest na liście niewykorzystanych.</p> : (
          <ul className="divide-y divide-line">
            {attached.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                <Link className="text-accent hover:underline" href={`/magazyn/${u.id}`}>{u.title} · <b>{u.option}</b></Link>
                <span className="font-mono text-xs text-muted">{u.code}</span>
                <span className="text-muted">{UNIT_STATUS[u.status] ?? u.status}</span>
                <form action={detachUnit} className="ml-auto">
                  <input type="hidden" name="id" value={c.id} />
                  <input type="hidden" name="unit_id" value={u.id} />
                  <input type="hidden" name="back" value={`/umowy/${c.id}/przypisz${source === "sprzedaz" ? "?zrodlo=sprzedaz" : ""}`} />
                  <SubmitButton className="btn-danger px-2.5 py-1 text-xs" pendingText="…">Odepnij</SubmitButton>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>
      <nav className="mb-4 flex gap-1 border-b border-line text-sm">
        {[["magazyn", "Magazyn (sztuki bez umowy)"], ["sprzedaz", "Sprzedaż (zamówienia)"]].map(([k, label]) => (
          <Link key={k} href={`/umowy/${c.id}/przypisz?zrodlo=${k}`} className={`-mb-px border-b-2 px-3 py-2 ${source === k ? "border-accent font-medium" : "border-transparent text-muted hover:text-ink"}`}>{label}</Link>
        ))}
      </nav>
      <form className="mb-4 flex flex-wrap gap-2" method="get">
        <input type="hidden" name="zrodlo" value={source} />
        <SearchInput wrapperClassName="w-full sm:w-96" name="q" defaultValue={sp.q} placeholder={source === "magazyn" ? "Nazwa, rozmiar, kod sztuki, IMEI, SKU" : "Numer zamówienia, klient, e-mail"} autoFocus />
        <button className="btn">Szukaj</button>
      </form>

      {source === "magazyn" ? (
        <div className="card overflow-x-auto">
          <table className="table mtable mtable-flow">
            <thead><tr><th>Produkt</th><th>Rozmiar</th><th>Kod</th><th>Status</th><th>Lokalizacja</th><th>Data</th><th /></tr></thead>
            <tbody>
              {!units.length && <tr><td colSpan={7} className="py-8 text-center text-muted">Brak sztuk bez umowy{q ? " dla tego wyszukiwania" : ""}.</td></tr>}
              {units.map((u) => (
                <tr key={u.id}>
                  <td>{u.title}</td>
                  <td className="font-medium">{u.option}</td>
                  <td className="font-mono text-xs">{u.code}{u.identifier && <span className="block text-muted">{u.identifier}</span>}</td>
                  <td className="text-sm">{UNIT_STATUS[u.status] ?? u.status}</td>
                  <td className="text-sm text-muted">{u.location_name}</td>
                  <td className="whitespace-nowrap text-sm text-muted">{dateTime(u.sold_at ?? u.received_at)}</td>
                  <td>
                    <form action={assignContractToUnit}>
                      <input type="hidden" name="contract_id" value={c.id} />
                      <input type="hidden" name="unit_id" value={u.id} />
                      <SubmitButton className="btn-secondary px-2.5 py-1 text-xs" pendingText="…">Przypisz</SubmitButton>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="table mtable mtable-flow">
            <thead><tr><th>Zamówienie</th><th>Data</th><th>Przedmiot bez umowy</th><th /></tr></thead>
            <tbody>
              {!orders.length && <tr><td colSpan={4} className="py-8 text-center text-muted">Brak zamówień.</td></tr>}
              {orders.flatMap((o) => (piecesOf.get(o.id) ?? []).map((p) => (
                <tr key={p.ref}>
                  <td><Link className="text-accent hover:underline" href={`/sprzedaz/${o.id}`}>{o.name}</Link><span className="block text-xs text-muted">{o.store?.name} · {o.customer_name}</span></td>
                  <td className="whitespace-nowrap text-sm text-muted">{dateTime(o.ordered_at)}</td>
                  <td>{p.line.title} · <b>{p.line.variant_title ?? "–"}</b>{p.line.quantity > 1 ? <span className="text-muted"> (sztuka {p.n + 1})</span> : null}</td>
                  <td>
                    <form action={assignContractToPiece}>
                      <input type="hidden" name="contract_id" value={c.id} />
                      <input type="hidden" name="ref" value={p.ref} />
                      <SubmitButton className="btn-secondary px-2.5 py-1 text-xs" pendingText="…">Przypisz</SubmitButton>
                    </form>
                  </td>
                </tr>
              )))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
