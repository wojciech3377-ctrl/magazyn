import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { dateTime, money, SALE_STATUS } from "@/lib/labels";
import { Notice, PageHeader, Pagination, Pill } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { pullOrdersNow } from "./actions";
import { SwapForm } from "./SwapForm";
import { WtbButton } from "@/components/WtbButton";
import { ReceiptButton } from "@/components/ReceiptButton";
import { SelectAllNamed } from "@/components/SelectAll";
import { Invoices, Jpk } from "./Jpk";
import { OrderStatusPill, SALE_SELECT, SaleContract, UnitCell, type SaleUnit } from "./SaleBits";
import { classifyShipment, ORDER_STATUS, paymentLabel, type Fulfillment, type OrderStatus } from "@/lib/orders/status";
import type { LineItem } from "@/lib/sync/shop-orders";

const PER_PAGE = 100;

const ORDER_TABS: { key: string; label: string }[] = [
  { key: "", label: "Wszystkie" },
  { key: "new", label: ORDER_STATUS.new },
  { key: "shipped", label: ORDER_STATUS.shipped },
  { key: "delivered", label: ORDER_STATUS.delivered },
  { key: "problem", label: ORDER_STATUS.problem },
  { key: "cancelled", label: ORDER_STATUS.cancelled },
  { key: "returned", label: ORDER_STATUS.returned },
];

export default async function SprzedazPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.strona ?? 1));
  if (sp.widok === "stacjonarna") return <PosList page={page} />;
  if (sp.widok === "linie") return <SaleLines sp={sp} page={page} />;
  if (sp.widok === "jpk" || sp.widok === "faktury") {
    return (
      <>
        <PageHeader title="Sprzedaż" sub={sp.widok === "jpk" ? "JPK: wszystkie sprzedaże według daty paragonu lub faktury, z danymi zakupu z umowy." : "Faktury sprzedaży i KSeF."} />
        <Tabs active={sp.widok} />
        {sp.widok === "jpk" ? <Jpk sp={sp} /> : <Invoices sp={sp} />}
      </>
    );
  }
  const { supabase, profile } = await requireProfile();
  const tab = ORDER_TABS.some((t) => t.key === sp.status) ? sp.status ?? "" : "";

  let query = supabase
    .from("orders")
    .select("id, name, ordered_at, receipt_id, customer_name, shipping_method, pickup_point, financial_status, cod, total, outstanding, currency, status, status_detail, line_items, fulfillments, store:stores(name)", { count: "exact" })
    .order("ordered_at", { ascending: false })
    .range((page - 1) * PER_PAGE, page * PER_PAGE - 1);
  if (tab) query = query.eq("status", tab);
  const q = (sp.q ?? "").replace(/[%,()#*]/g, "").trim();
  if (q) query = query.or(`number.ilike.%${q}%,customer_name.ilike.%${q}%,email.ilike.%${q}%`);

  const [{ data: orders, count }, counts, { count: problems }, { data: logs }] = await Promise.all([
    query,
    Promise.all(ORDER_TABS.map((t) => {
      let c = supabase.from("orders").select("id", { count: "exact", head: true });
      if (t.key) c = c.eq("status", t.key);
      return c;
    })),
    supabase.from("sales").select("id", { count: "exact", head: true }).eq("status", "no_unit"),
    supabase.from("sync_log").select("job, ok, message, created_at").in("job", ["base-orders", "shopify-orders", "furgonetka"]).order("created_at", { ascending: false }).limit(12),
  ]);
  const lastOf = (job: string) => (logs ?? []).find((l) => l.job === job);
  const lastShop = lastOf("shopify-orders");
  const lastBase = lastOf("base-orders");
  const lastShip = lastOf("furgonetka");

  const ids = (orders ?? []).map((o) => o.id);
  const [{ data: sales }, { data: shipments }] = ids.length
    ? await Promise.all([
        supabase.from("sales").select("id, order_id, status, variant_id, unit:units(id, code, contract_id)").in("order_id", ids),
        supabase.from("shipments").select("order_id, service, tracking_number, tracking_url, state, state_description").in("order_id", ids).order("created_at", { ascending: false }),
      ])
    : [{ data: [] }, { data: [] }];
  type ListSale = { id: string; status: string; variant_id: string | null; unit: { id: string; code: string; contract_id: string | null } | null };
  const salesBy = new Map<string, ListSale[]>();
  for (const s of sales ?? []) salesBy.set(s.order_id as string, [...(salesBy.get(s.order_id as string) ?? []), s as unknown as ListSale]);
  const listSaleIds = (sales ?? []).map((s) => s.id as string);
  const { data: saleContracts } = listSaleIds.length
    ? await supabase.from("contracts").select("sale_id").in("sale_id", listSaleIds).not("status", "in", "(cancelled,rejected)")
    : { data: [] };
  const saleHasContract = new Set((saleContracts ?? []).map((c) => c.sale_id as string));
  const shipBy = new Map<string, { service: string | null; tracking_number: string | null; tracking_url: string | null; state: string | null; state_description: string | null }>();
  for (const s of shipments ?? []) if (!shipBy.has(s.order_id as string) && classifyShipment(s) !== null) shipBy.set(s.order_id as string, s);

  return (
    <>
      <PageHeader
        title="Sprzedaż"
        sub={<>Zamówienia ze sklepów Shopify. Ostatni odczyt: {lastShop ? dateTime(lastShop.created_at) : "jeszcze nie było"}{lastShip ? <> · przesyłki: {dateTime(lastShip.created_at)}</> : null}.</>}
        actions={profile.role === "admin" ? (
          <form action={pullOrdersNow}><SubmitButton className="btn-secondary" pendingText="Pobieram…">Pobierz zamówienia teraz</SubmitButton></form>
        ) : null}
      />
      <Tabs active="orders" />
      {lastShop && !lastShop.ok && <div className="mb-4"><Notice tone="error">Odczyt zamówień z Shopify nie udał się: {lastShop.message}</Notice></div>}
      {lastBase && !lastBase.ok && <div className="mb-4"><Notice tone="error">Przypisanie sztuk (Base) nie udało się: {lastBase.message}</Notice></div>}
      {lastShip && !lastShip.ok && <div className="mb-4"><Notice tone="error">Odczyt przesyłek z Furgonetki nie udał się: {lastShip.message}</Notice></div>}
      {!!problems && <div className="mb-4"><Notice tone="error">{problems} {problems === 1 ? "linia zamówienia nie ma" : "linii zamówień nie ma"} sztuki na stanie. <Link className="underline" href="/sprzedaz?widok=linie&status=no_unit">Pokaż</Link> i przypisz sztukę skanem albo wygeneruj umowę.</Notice></div>}

      <nav className="mb-4 flex flex-wrap gap-1 border-b border-line text-sm" aria-label="Status zamówień">
        {ORDER_TABS.map((t, i) => (
          <Link
            key={t.key}
            href={`/sprzedaz${t.key ? `?status=${t.key}` : ""}`}
            className={`-mb-px border-b-2 px-3 py-2 ${tab === t.key ? "border-accent font-medium text-ink" : "border-transparent text-muted hover:text-ink"} ${t.key === "problem" && (counts[i].count ?? 0) > 0 ? "text-bad" : ""}`}
          >
            {t.label} <span className={`ml-1 rounded px-1.5 py-0.5 text-xs tabular-nums ${t.key === "problem" && (counts[i].count ?? 0) > 0 ? "bg-bad text-white" : "bg-panel"}`}>{counts[i].count ?? 0}</span>
          </Link>
        ))}
      </nav>

      <form className="mb-4 flex flex-wrap gap-2" method="get">
        {tab && <input type="hidden" name="status" value={tab} />}
        <input className="input w-72" name="q" defaultValue={sp.q} placeholder="Numer zamówienia, klient albo e-mail" />
        <button className="btn">Szukaj</button>
      </form>

      {/* Zaznaczone zamówienia → paczka umów (ZIP). Pola wyboru są w wierszach (atrybut form). */}
      <form id="umowy-paczka" action="/api/umowy/paczka" method="get" className="mb-2 flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2"><SelectAllNamed name="zamowienia" /> zaznacz wszystkie</label>
        <button className="btn-secondary px-3 py-1.5 text-sm">Pobierz umowy zaznaczonych (ZIP)</button>
      </form>
      <div className="card overflow-x-auto">
        <table className="table">
          <thead><tr><th className="w-8" /><th>Data</th><th>Zamówienie</th><th>Produkty</th><th>Wysyłka</th><th>Płatność</th><th>Status</th><th /></tr></thead>
          <tbody>
            {!orders?.length && (
              <tr><td colSpan={8} className="py-10 text-center text-muted">{tab || q ? "Brak zamówień." : "Zamówienia pojawią się po pierwszym odczycie ze Shopify (co 5 minut albo przyciskiem „Pobierz zamówienia teraz”)."}</td></tr>
            )}
            {orders?.map((o) => {
              const lines = ((o.line_items ?? []) as LineItem[]).map((l, i) => ({ ...l, i })).filter((l) => !l.service);
              const pay = paymentLabel(o);
              const oSales = salesBy.get(o.id) ?? [];
              const ship = shipBy.get(o.id);
              const shopTracking = ((o.fulfillments ?? []) as Fulfillment[]).flatMap((f) => f.trackingInfo).find((t) => t.number);
              const tracking = ship?.tracking_number ? { number: ship.tracking_number, url: ship.tracking_url } : shopTracking ? { number: shopTracking.number!, url: shopTracking.url } : null;
              const status = o.status as OrderStatus;
              return (
                <tr key={o.id} className={`relative cursor-pointer transition-colors ${status === "problem" ? "bg-rose-50/60 hover:bg-rose-100/70" : "hover:bg-sky-50"}`}>
                  <td><input type="checkbox" name="zamowienia" value={o.id} form="umowy-paczka" className="relative z-10 h-4 w-4" aria-label={`Zaznacz ${o.name}`} /></td>
                  <td className="whitespace-nowrap text-muted">{dateTime(o.ordered_at)}</td>
                  <td className="whitespace-nowrap">
                    {/* Cały wiersz prowadzi do zamówienia (link rozciągnięty na wiersz); pozostałe linki są nad nim. */}
                    <Link className="font-medium text-accent after:absolute after:inset-0 after:content-[''] hover:underline" href={`/sprzedaz/${o.id}`}>{o.name}</Link>
                    <span className="block text-xs text-muted">{(o.store as unknown as { name: string } | null)?.name ?? ""}</span>
                    {o.customer_name && <span className="block text-xs">{o.customer_name}</span>}
                  </td>
                  <td className="min-w-64 max-w-96">
                    <ul className="space-y-0.5 text-sm">
                      {lines.map((l) => (
                        <li key={l.id} className="flex items-baseline gap-2">
                          <span className="line-clamp-1">{l.title} · <b>{l.variant_title ?? "–"}</b>{l.quantity > 1 ? ` ×${l.quantity}` : ""}</span>
                          <WtbButton orderId={o.id} line={l.i} compact />
                        </li>
                      ))}
                    </ul>
                    <div className="mt-0.5 flex flex-wrap gap-1 font-mono text-xs">
                      {oSales.map((s, i) => s.unit
                        ? <Link key={i} className="relative z-10 text-accent hover:underline" href={`/magazyn/${s.unit.id}`}>{s.unit.code}</Link>
                        : s.status === "no_unit" ? <Pill key={i} tone="red">brak sztuki</Pill> : null)}
                    </div>
                  </td>
                  <td className="text-sm">
                    <span className="line-clamp-2">{o.shipping_method ?? "–"}</span>
                    {o.pickup_point && <span className="block font-mono text-xs text-muted">{o.pickup_point}</span>}
                    {tracking && (tracking.url
                      ? <a className="relative z-10 block font-mono text-xs text-accent hover:underline" href={tracking.url} target="_blank" rel="noreferrer">{tracking.number}</a>
                      : <span className="block font-mono text-xs">{tracking.number}</span>)}
                  </td>
                  <td className="whitespace-nowrap">
                    <Pill tone={pay.tone}>{pay.text}</Pill>
                    <span className="block text-sm tabular-nums">{o.currency && o.currency !== "PLN" ? `${Number(o.total).toFixed(2)} ${o.currency}` : money(o.total)}</span>
                  </td>
                  <td className="max-w-56">
                    <OrderStatusPill status={status} />
                    {o.status_detail && <span className={`mt-0.5 block text-xs ${status === "problem" ? "font-medium text-bad" : "text-muted"}`}>{o.status_detail}</span>}
                  </td>
                  <td>
                    <div className="flex flex-col items-start gap-1.5">
                      <ContractAction sales={oSales} saleHasContract={saleHasContract} />
                      {status === "new" && <Link className="btn-secondary relative z-10 whitespace-nowrap px-2.5 py-1 text-xs" href={`/sprzedaz/${o.id}#etykieta`}>Utwórz etykietę</Link>}
                      {status !== "cancelled" && status !== "returned" && <ReceiptButton orderId={o.id} receiptId={o.receipt_id as number | null} compact />}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Pagination page={page} total={count ?? 0} perPage={PER_PAGE} params={{ q: sp.q, status: tab || undefined }} />
    </>
  );
}

/** Linie sprzedaży z Base: przypisanie sztuk, umowy, zamiana sztuki przy pakowaniu. */
async function SaleLines({ sp, page }: { sp: Record<string, string | undefined>; page: number }) {
  const { supabase } = await requireProfile();
  const status = sp.status ?? "";
  let query = supabase
    .from("sales")
    .select(SALE_SELECT, { count: "exact" })
    .order("sold_at", { ascending: false })
    .range((page - 1) * PER_PAGE, page * PER_PAGE - 1);
  if (status) query = query.eq("status", status);
  else query = query.neq("status", "unmatched");
  if (sp.q) query = query.ilike("order_ref", `%${sp.q.replace(/[%,()]/g, "")}%`);

  const [{ data: sales, count }, { data: lastSync }] = await Promise.all([
    query,
    supabase.from("sync_log").select("ok, message, created_at").eq("job", "base-orders").order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const saleIds = (sales ?? []).map((x) => x.id);
  const { data: pendingContracts } = saleIds.length
    ? await supabase.from("contracts").select("id, status, sale_id").in("sale_id", saleIds).not("status", "in", "(cancelled,rejected)")
    : { data: [] };
  const pendingBySale = new Map((pendingContracts ?? []).map((c) => [c.sale_id as string, c]));

  return (
    <>
      <PageHeader title="Sprzedaż" sub={<>Linie zamówień z Base: aplikacja bierze najpierw Twoje sztuki, potem komis, zawsze od najstarszej. Ostatni odczyt: {lastSync ? `${dateTime(lastSync.created_at)}${lastSync.ok ? "" : " (błąd)"}` : "jeszcze nie było"}.</>} />
      <Tabs active="lines" />
      <form className="mb-4 flex flex-wrap gap-2" method="get">
        <input type="hidden" name="widok" value="linie" />
        <input className="input w-56" name="q" defaultValue={sp.q} placeholder="Numer zamówienia" />
        <select className="input w-64" name="status" defaultValue={status}>
          <option value="">Wszystkie (bez niepowiązanych)</option>
          {Object.entries(SALE_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <button className="btn">Filtruj</button>
      </form>

      <div className="card overflow-x-auto">
        <table className="table">
          <thead><tr><th>Data</th><th>Zamówienie</th><th>Produkt</th><th>Sztuka</th><th>Status</th><th>Umowa</th><th>Zmień sztukę przy pakowaniu</th><th /></tr></thead>
          <tbody>
            {!sales?.length && <tr><td colSpan={8} className="py-10 text-center text-muted">Brak sprzedaży.</td></tr>}
            {sales?.map((s) => {
              const variant = s.variant as unknown as { option: string; product: { title: string } } | null;
              return (
                <tr key={s.id}>
                  <td className="whitespace-nowrap text-muted">{dateTime(s.sold_at)}</td>
                  <td className="whitespace-nowrap font-medium">
                    {s.order_id ? <Link className="text-accent hover:underline" href={`/sprzedaz/${s.order_id}`}>{s.order_ref}</Link> : s.order_ref}
                    <span className="block text-xs text-muted">{(s.store as unknown as { name: string } | null)?.name ?? ""}</span>
                  </td>
                  <td>{variant ? <>{variant.product.title} · <b>{variant.option}</b></> : <span className="text-muted">{s.product_name}</span>}</td>
                  <td className="whitespace-nowrap"><UnitCell unit={s.unit as unknown as SaleUnit} /></td>
                  <td><Pill tone={s.status === "assigned" ? "green" : s.status === "cancelled" ? "slate" : "red"}>{SALE_STATUS[s.status]}</Pill></td>
                  <td className="whitespace-nowrap"><SaleContract saleId={s.id} status={s.status} hasVariant={!!s.variant_id} unit={s.unit as unknown as SaleUnit} pending={pendingBySale.get(s.id)} /></td>
                  <td>{s.status !== "cancelled" && s.status !== "unmatched" && <SwapForm saleId={s.id} />}</td>
                  <td>{s.variant_id && <WtbButton saleId={s.id} compact />}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Pagination page={page} total={count ?? 0} perPage={PER_PAGE} params={{ widok: "linie", q: sp.q, status: sp.status }} />
    </>
  );
}

function Tabs({ active }: { active: "orders" | "lines" | "pos" | "faktury" | "jpk" }) {
  const cls = (on: boolean) => `rounded-md px-3 py-1.5 ${on ? "bg-ink text-white" : "text-muted hover:bg-panel"}`;
  return (
    <div className="mb-4 flex flex-wrap gap-1 text-sm">
      <Link href="/sprzedaz" className={cls(active === "orders")}>Zamówienia</Link>
      <Link href="/sprzedaz?widok=stacjonarna" className={cls(active === "pos")}>Sprzedaż stacjonarna</Link>
      <Link href="/sprzedaz?widok=faktury" className={cls(active === "faktury")}>Faktury</Link>
      <Link href="/sprzedaz?widok=jpk" className={cls(active === "jpk" || active === "lines")}>JPK</Link>
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

/**
 * „Dołącz umowę” dla każdego sprzedanego przedmiotu bez umowy – także już wysłanego (1 umowa na przedmiot):
 * sztuki z magazynu bez umowy oraz pozycje bez sztuki (umowa utworzy dla nich sprzedaną sztukę).
 */
function ContractAction({ sales, saleHasContract }: {
  sales: { id: string; status: string; variant_id: string | null; unit: { id: string; contract_id: string | null } | null }[];
  saleHasContract: Set<string>;
}) {
  const live = sales.filter((s) => s.status !== "cancelled");
  const unitsWithout = live.filter((s) => s.unit && !s.unit.contract_id && !saleHasContract.has(s.id)).map((s) => s.unit!.id);
  const noUnit = live.filter((s) => !s.unit && s.variant_id && !saleHasContract.has(s.id));
  const btn = "btn-secondary relative z-10 whitespace-nowrap px-2.5 py-1 text-xs";
  if (!unitsWithout.length && !noUnit.length) {
    return live.some((s) => s.unit?.contract_id || saleHasContract.has(s.id)) ? <span className="whitespace-nowrap text-xs text-ok">umowa ✓</span> : null;
  }
  return (
    <>
      {unitsWithout.length > 0 && <Link className={btn} href={`/umowy/z-szablonu?ids=${unitsWithout.join(",")}`}>Dołącz umowę{unitsWithout.length > 1 ? ` (${unitsWithout.length})` : ""}</Link>}
      {noUnit.map((s) => <Link key={s.id} className={btn} href={`/umowy/z-szablonu?sprzedaz=${s.id}`}>Dołącz umowę{noUnit.length > 1 || unitsWithout.length ? " (bez sztuki)" : ""}</Link>)}
    </>
  );
}
