import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { dateTime, money, SALE_STATUS } from "@/lib/labels";
import { Notice, PageHeader, Pagination, Pill } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { pullOrdersNow } from "./actions";
import { SwapForm } from "./SwapForm";

const PER_PAGE = 100;

export default async function SprzedazPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { supabase, profile } = await requireProfile();
  const page = Math.max(1, Number(sp.strona ?? 1));
  if (sp.widok === "stacjonarna") return <PosList page={page} />;
  const status = sp.status ?? "";

  let query = supabase
    .from("sales")
    .select("id, order_ref, product_name, status, sold_at, store:stores(name), unit:units(id, code, identifier, owner_type, status, consignor:consignors(name), contract:contracts(id, counterparty, status)), variant:variants(option, product:products(title))", { count: "exact" })
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
  const saleIds = (sales ?? []).map((x) => x.id);
  const { data: pendingContracts } = saleIds.length
    ? await supabase.from("contracts").select("id, status, sale_id").in("sale_id", saleIds).not("status", "in", "(cancelled,rejected)")
    : { data: [] };
  const pendingBySale = new Map((pendingContracts ?? []).map((c) => [c.sale_id as string, c]));

  return (
    <>
      <PageHeader
        title="Sprzedaż"
        sub={<>Zamówienia z Base. Aplikacja bierze najpierw Twoje sztuki, potem komis, zawsze od najstarszej. Ostatni odczyt: {lastSync ? `${dateTime(lastSync.created_at)}${lastSync.ok ? "" : " (błąd)"}` : "jeszcze nie było"}.</>}
        actions={profile.role === "admin" ? (
          <form action={pullOrdersNow}><SubmitButton className="btn-secondary" pendingText="Pobieram…">Pobierz zamówienia teraz</SubmitButton></form>
        ) : null}
      />
      <Tabs active="base" />
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
          <thead><tr><th>Data</th><th>Zamówienie</th><th>Produkt</th><th>Sztuka</th><th>Status</th><th>Umowa</th><th>Zmień sztukę przy pakowaniu</th></tr></thead>
          <tbody>
            {!sales?.length && <tr><td colSpan={7} className="py-10 text-center text-muted">Brak sprzedaży.</td></tr>}
            {sales?.map((s) => {
              const unit = s.unit as unknown as { id: string; code: string; identifier: string | null; owner_type: string; status: string; consignor: { name: string } | null; contract: { id: string; counterparty: string; status: string } | null } | null;
              const pending = pendingBySale.get(s.id);
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
                  <td className="whitespace-nowrap">
                    {unit?.contract ? (
                      <Link className="text-accent hover:underline" href={`/umowy/${unit.contract.id}`}>{unit.contract.status === "sent" ? "czeka na podpis" : unit.contract.status === "signed" ? "do zatwierdzenia" : unit.contract.counterparty}</Link>
                    ) : pending ? (
                      <Link className="text-accent hover:underline" href={`/umowy/${pending.id}`}>{pending.status === "sent" ? "czeka na podpis" : pending.status === "signed" ? "do zatwierdzenia" : pending.status === "rejected" ? "odrzucona" : "zatwierdzona"}</Link>
                    ) : s.status === "no_unit" && s.variant ? (
                      <Link className="btn-secondary px-2.5 py-1 text-xs" href={`/umowy/z-szablonu?sprzedaz=${s.id}`}>Generuj umowę</Link>
                    ) : unit ? (
                      <Link className="btn-secondary px-2.5 py-1 text-xs" href={`/umowy/z-szablonu?ids=${unit.id}`}>Dodaj umowę</Link>
                    ) : null}
                    {unit?.status === "in_transit" && <span className="block text-xs text-warn">towar w drodze</span>}
                  </td>
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

function Tabs({ active }: { active: "base" | "pos" }) {
  const cls = (on: boolean) => `rounded-md px-3 py-1.5 ${on ? "bg-ink text-white" : "text-muted hover:bg-panel"}`;
  return (
    <div className="mb-4 flex gap-1 text-sm">
      <Link href="/sprzedaz" className={cls(active === "base")}>Zamówienia z Base</Link>
      <Link href="/sprzedaz?widok=stacjonarna" className={cls(active === "pos")}>Sprzedaż stacjonarna</Link>
    </div>
  );
}

const PAYMENT: Record<string, string> = { card: "karta", cash: "gotówka", blik: "BLIK", transfer: "przelew", other: "inna" };

async function PosList({ page }: { page: number }) {
  const { supabase } = await requireProfile();
  const { data, count } = await supabase
    .from("pos_orders")
    .select("id, code, total, payment_method, customer, created_at, base_sync_status, store:stores(name), items:pos_order_items(count)", { count: "exact" })
    .order("created_at", { ascending: false })
    .range((page - 1) * PER_PAGE, page * PER_PAGE - 1);
  return (
    <>
      <PageHeader title="Sprzedaż" sub="Sprzedaż stacjonarna z kasy." actions={<Link className="btn" href="/kasa">Nowa sprzedaż</Link>} />
      <Tabs active="pos" />
      <div className="card overflow-x-auto">
        <table className="table">
          <thead><tr><th>Data</th><th>Numer</th><th>Sklep</th><th className="text-right">Sztuk</th><th>Płatność</th><th className="text-right">Kwota</th><th>Base</th></tr></thead>
          <tbody>
            {!data?.length && <tr><td colSpan={7} className="py-10 text-center text-muted">Brak sprzedaży stacjonarnej.</td></tr>}
            {data?.map((o) => (
              <tr key={o.id}>
                <td className="whitespace-nowrap text-muted">{dateTime(o.created_at)}</td>
                <td><Link className="font-medium text-accent hover:underline" href={`/kasa/${o.id}`}>{o.code}</Link>{o.customer && <span className="block text-xs text-muted">{o.customer}</span>}</td>
                <td>{(o.store as unknown as { name: string }).name}</td>
                <td className="text-right tabular-nums">{(o.items as unknown as { count: number }[])[0]?.count ?? 0}</td>
                <td>{PAYMENT[o.payment_method] ?? o.payment_method}</td>
                <td className="text-right tabular-nums">{money(o.total)}</td>
                <td><Pill tone={o.base_sync_status === "ok" ? "green" : "red"}>{o.base_sync_status === "ok" ? "ok" : "do sprawdzenia"}</Pill></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination page={page} total={count ?? 0} perPage={PER_PAGE} params={{ widok: "stacjonarna" }} />
    </>
  );
}
