import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { dateTime, SALE_STATUS } from "@/lib/labels";
import { Notice, PageHeader, Pagination, Pill } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { pullOrdersNow } from "./actions";
import { SwapForm } from "./SwapForm";

const PER_PAGE = 100;

export default async function SprzedazPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { supabase, profile } = await requireProfile();
  const page = Math.max(1, Number(sp.strona ?? 1));
  const status = sp.status ?? "";

  let query = supabase
    .from("sales")
    .select("id, order_ref, product_name, status, sold_at, store:stores(name), unit:units(id, code, identifier, owner_type, consignor:consignors(name)), variant:variants(option, product:products(title))", { count: "exact" })
    .order("sold_at", { ascending: false })
    .range((page - 1) * PER_PAGE, page * PER_PAGE - 1);
  if (status) query = query.eq("status", status);
  else query = query.neq("status", "unmatched");
  if (sp.q) query = query.ilike("order_ref", `%${sp.q.replace(/[%,()]/g, "")}%`);

  const [{ data: sales, count }, { count: problems }, { data: lastSync }] = await Promise.all([
    query,
    supabase.from("sales").select("id", { count: "exact", head: true }).eq("status", "no_unit"),
    supabase.from("sync_log").select("ok, message, created_at").eq("job", "base-orders").order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);

  return (
    <>
      <PageHeader
        title="Sprzedaż"
        sub={<>Zamówienia z Base. Aplikacja bierze najpierw Twoje sztuki, potem komis, zawsze od najstarszej. Ostatni odczyt: {lastSync ? `${dateTime(lastSync.created_at)}${lastSync.ok ? "" : " (błąd)"}` : "jeszcze nie było"}.</>}
        actions={profile.role === "admin" ? (
          <form action={pullOrdersNow}><SubmitButton className="btn-secondary" pendingText="Pobieram…">Pobierz zamówienia teraz</SubmitButton></form>
        ) : null}
      />
      {lastSync && !lastSync.ok && <div className="mb-4"><Notice tone="error">Ostatni odczyt zamówień nie udał się: {lastSync.message}</Notice></div>}
      {!!problems && <div className="mb-4"><Notice tone="error">{problems} {problems === 1 ? "linia zamówienia nie ma" : "linii zamówień nie ma"} sztuki na stanie. <Link className="underline" href="/sprzedaz?status=no_unit">Pokaż</Link> i przypisz sztukę skanem.</Notice></div>}

      <form className="mb-4 flex flex-wrap gap-2" method="get">
        <input className="input w-56" name="q" defaultValue={sp.q} placeholder="Numer zamówienia" />
        <select className="input w-64" name="status" defaultValue={status}>
          <option value="">Wszystkie (bez niepowiązanych)</option>
          {Object.entries(SALE_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <button className="btn">Filtruj</button>
      </form>

      <div className="card overflow-x-auto">
        <table className="table">
          <thead><tr><th>Data</th><th>Zamówienie</th><th>Produkt</th><th>Sztuka</th><th>Status</th><th>Zmień sztukę przy pakowaniu</th></tr></thead>
          <tbody>
            {!sales?.length && <tr><td colSpan={6} className="py-10 text-center text-muted">Brak sprzedaży.</td></tr>}
            {sales?.map((s) => {
              const unit = s.unit as unknown as { id: string; code: string; identifier: string | null; owner_type: string; consignor: { name: string } | null } | null;
              const variant = s.variant as unknown as { option: string; product: { title: string } } | null;
              return (
                <tr key={s.id}>
                  <td className="whitespace-nowrap text-muted">{dateTime(s.sold_at)}</td>
                  <td className="whitespace-nowrap font-medium">{s.order_ref}<span className="block text-xs text-muted">{(s.store as unknown as { name: string } | null)?.name ?? ""}</span></td>
                  <td>{variant ? <>{variant.product.title} · <b>{variant.option}</b></> : <span className="text-muted">{s.product_name}</span>}</td>
                  <td className="whitespace-nowrap font-mono text-xs">
                    {unit ? <Link className="text-accent hover:underline" href={`/magazyn/${unit.id}`}>{unit.code}</Link> : "–"}
                    {unit?.identifier && <span className="block text-muted">{unit.identifier}</span>}
                    {unit?.owner_type === "consignment" && <span className="block"><Pill tone="blue">komis · {unit.consignor?.name}</Pill></span>}
                  </td>
                  <td><Pill tone={s.status === "assigned" ? "green" : s.status === "cancelled" ? "slate" : "red"}>{SALE_STATUS[s.status]}</Pill></td>
                  <td>{s.status !== "cancelled" && s.status !== "unmatched" && <SwapForm saleId={s.id} />}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Pagination page={page} total={count ?? 0} perPage={PER_PAGE} params={{ q: sp.q, status: sp.status }} />
    </>
  );
}
