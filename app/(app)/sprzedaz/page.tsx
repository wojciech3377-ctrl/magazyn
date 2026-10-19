import { CashDrawer } from "./CashDrawer";
import { searchWords, wordsOr } from "@/lib/search";
import { warsawDayRange } from "@/lib/month";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { dateTime, money, SALE_STATUS } from "@/lib/labels";
import { Notice, PageHeader, Pagination, Pill } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { attachContractForPiece, deletePosOrder, pullOrdersNow } from "./actions";
import { ConfirmSubmit } from "@/components/ConfirmSubmit";
import { matchPieces, type Piece } from "@/lib/orders/pieces";
import { SwapForm } from "./SwapForm";
import { WtbButton, WtbOrderButton } from "@/components/WtbButton";
import { ReceiptButton } from "@/components/ReceiptButton";
import { fiscalPrinterReady } from "@/lib/fiscal/jobs";
import { createAdminClient } from "@/lib/supabase/admin";
import type { JobView } from "./receipt-actions";
import { Invoices, Jpk } from "./Jpk";
import { OrderStatusPill, SALE_SELECT, SaleContract, UnitCell, type SaleUnit } from "./SaleBits";
import { CONTRACT_LITE_FIELDS, contractStage, isSettled, MISSING_BTN, type ContractLite } from "@/lib/contracts/stage";
import { ConsignorWaiting, ContractDone, ContractInProgress } from "@/components/ContractBadges";
import { classifyShipment, ORDER_STATUS, paymentLabel, type Fulfillment, type OrderStatus } from "@/lib/orders/status";
import { FilterField, ListToolbar } from "@/components/ListToolbar";
import { activeFilters, filterChips } from "@/lib/list-params";
import { pickDefaultStore } from "@/lib/orders/default-store";
import { isParOrder } from "@/lib/orders/par-order";
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
  // Uprawnienia: zamówienia i sprzedaż stacjonarna – „sprzedaz”, faktury i JPK – „faktury”.
  const { profile: me } = await requireProfile();
  const invoicesView = sp.widok === "jpk" || sp.widok === "faktury";
  if (invoicesView && !can(me, "faktury")) redirect("/sprzedaz");
  if (!invoicesView && !can(me, "sprzedaz")) redirect("/sprzedaz?widok=faktury");
  if (sp.widok === "stacjonarna") return <PosList page={page} q={sp.q ?? ""} sp={sp} />;
  if (sp.widok === "linie") return <SaleLines sp={sp} page={page} />;
  if (sp.widok === "jpk" || sp.widok === "faktury") {
    return (
      <>
        <PageHeader title="Sprzedaż" sub={sp.widok === "jpk" ? "JPK: wszystkie sprzedaże według daty paragonu lub faktury, z danymi zakupu z umowy." : "Faktury sprzedaży i KSeF."} />
        <Tabs active={sp.widok} />
        <Flash sp={sp} />
        {sp.widok === "jpk" ? <Jpk sp={sp} /> : <Invoices sp={sp} />}
      </>
    );
  }
  const { supabase, profile } = await requireProfile();
  const tab = ORDER_TABS.some((t) => t.key === sp.status) ? sp.status ?? "" : "";
  // Sklep: wybrany w przełączniku albo domyślny z Ustawień (bez ustawienia – Sneakers Depot).
  const [{ data: storeList }, { data: ordersCfg }] = await Promise.all([
    supabase.from("stores").select("id, name").order("name"),
    supabase.from("app_settings").select("value").eq("key", "orders").maybeSingle(),
  ]);
  const storeSel = sp.sklep === "wszystkie" || storeList?.some((x) => x.id === sp.sklep) ? sp.sklep! : pickDefaultStore(ordersCfg?.value, storeList ?? []);
  const storeId = storeSel === "wszystkie" ? null : storeSel;

  const orderSort = ORDER_SORTS[sp.sort ?? ""] ? sp.sort! : "najnowsze";
  let query = supabase
    .from("orders")
    .select("id, name, shopify_order_id, ordered_at, receipt_id, customer_name, shipping_method, pickup_point, financial_status, cod, total, outstanding, currency, status, status_detail, line_items, fulfillments, return_status, refunded_amount, refund_pending, refunded_lines, email, phone, shipping_address, note, store:stores(name)", { count: "exact" })
    .order(ORDER_SORTS[orderSort].column, { ascending: ORDER_SORTS[orderSort].asc })
    .range((page - 1) * PER_PAGE, page * PER_PAGE - 1);
  if (tab) query = query.eq("status", tab);
  if (storeId) query = query.eq("store_id", storeId);
  // Daty według czasu polskiego (wcześniej UTC – zamówienia z 0:00–2:00 wpadały w zły dzień).
  const odR = warsawDayRange(sp.od), doR = warsawDayRange(sp.do);
  if (odR) query = query.gte("ordered_at", odR.from);
  if (doR) query = query.lt("ordered_at", doR.to);
  if (sp.platnosc === "pobranie") query = query.eq("cod", true);
  if (sp.platnosc === "oplacone") query = query.in("financial_status", ["PAID", "PARTIALLY_REFUNDED"]);
  // Nieopłacone: czeka na płatność (bez pobrań; anulowane i zwrócone to nie „nieopłacone”).
  if (sp.platnosc === "nieoplacone") query = query.in("financial_status", ["PENDING", "AUTHORIZED", "PARTIALLY_PAID", "EXPIRED"]).eq("cod", false).is("cancelled_at", null);
  const q = (sp.q ?? "").replace(/[%,()#*]/g, "").trim();
  const qex = wordsOr(["number", "customer_name", "email", "phone"], searchWords(q));
  if (qex) query = query.or(qex);

  const [{ data: orders, count }, counts, { count: problems }, { data: logs }] = await Promise.all([
    query,
    Promise.all(ORDER_TABS.map((t) => {
      let c = supabase.from("orders").select("id", { count: "exact", head: true });
      if (t.key) c = c.eq("status", t.key);
      if (storeId) c = c.eq("store_id", storeId);
      return c;
    })),
    // Wysłane, dostarczone, zwrócone i anulowane zamówienia nie są już problemem braku sztuki.
    supabase.from("sales").select("id, order:orders!inner(status)", { count: "exact", head: true }).eq("status", "no_unit").not("order.status", "in", "(shipped,delivered,returned,cancelled)"),
    supabase.from("sync_log").select("job, ok, message, created_at").in("job", ["shopify-orders", "furgonetka", "live"]).order("created_at", { ascending: false }).limit(30),
  ]);
  const listParams = { q: sp.q, status: tab || undefined, sklep: sp.sklep, platnosc: sp.platnosc, od: sp.od, do: sp.do, sort: sp.sort };
  const withStore = (extra: Record<string, string>) => { const q = new URLSearchParams({ ...(sp.sklep ? { sklep: sp.sklep } : {}), ...extra }); return `/sprzedaz${q.size ? `?${q}` : ""}`; };
  const lastOf = (job: string) => (logs ?? []).find((l) => l.job === job);
  const lastShop = lastOf("shopify-orders");
  const lastShip = lastOf("furgonetka");
  // Problemy z odczytem z ostatnich 30 min (także pominięte pojedyncze zamówienia i odczyt na żywo).
  const recentError = (logs ?? []).find((l) => !l.ok && l.job !== "furgonetka" && Date.now() - Date.parse(l.created_at) < 30 * 60_000);
  const cronStale = !lastShop || Date.now() - Date.parse(lastShop.created_at) > 10 * 60_000;

  const ids = (orders ?? []).map((o) => o.id);
  const gids = [...new Set((orders ?? []).flatMap((o) => ((o.line_items ?? []) as LineItem[]).map((l) => l.shopify_variant_id).filter((x): x is string => !!x)))];
  const none = Promise.resolve({ data: [] as never[] });
  // Wszystko, co zależy tylko od listy zamówień – jednym rzutem, równolegle.
  const [{ data: receiptJobs }, printer, { data: wtbRows }, { data: sales }, { data: shipments }, { data: vLinks }, fresh, { data: noteRows }] = await Promise.all([
    ids.length ? supabase.from("receipt_jobs").select("id, order_id, status, receipt_number, error, claimed_at, number").in("order_id", ids).neq("status", "cancelled") : none,
    fiscalPrinterReady(createAdminClient()),
    ids.length ? supabase.from("wtb_items").select("order_id").in("order_id", ids).eq("status", "active") : none,
    ids.length ? supabase.from("sales").select(`id, order_id, status, variant_id, shopify_line_id, shopify_line_index, unit:units(id, code, contract_id, owner_type, contract:contracts(${CONTRACT_LITE_FIELDS}))`).in("order_id", ids) : none,
    ids.length ? supabase.from("shipments").select("order_id, service, tracking_number, tracking_url, state, state_description").in("order_id", ids).order("created_at", { ascending: false }) : none,
    gids.length ? supabase.from("variant_store_links").select("variant_id, shopify_variant_id").in("shopify_variant_id", gids) : none,
    newOrdersCount(),
    // Notatki pracowników (SQL 69) – osobno, żeby lista działała także bez migracji.
    ids.length ? supabase.from("orders").select("id, staff_note").in("id", ids).not("staff_note", "is", null).then((r) => (r.error ? { data: [] } : r)) : none,
  ]);
  const staffNote = new Map(((noteRows ?? []) as { id: string; staff_note: string | null }[]).map((r) => [r.id, r.staff_note]));
  const jobOf = new Map((receiptJobs ?? []).map((j) => [j.order_id as string, j as unknown as JobView]));
  const wtbOrders = new Set((wtbRows ?? []).map((w) => w.order_id as string));
  type ListSale = { id: string; status: string; variant_id: string | null; shopify_line_id: string | null; shopify_line_index: number | null; unit: { id: string; code: string; contract_id: string | null; owner_type: string; contract: ContractLite | null } | null };
  const variantOf = new Map((vLinks ?? []).map((l) => [l.shopify_variant_id as string, l.variant_id as string]));
  const salesBy = new Map<string, ListSale[]>();
  for (const s of sales ?? []) salesBy.set(s.order_id as string, [...(salesBy.get(s.order_id as string) ?? []), s as unknown as ListSale]);
  const listSaleIds = (sales ?? []).map((s) => s.id as string);
  const { data: saleContracts } = listSaleIds.length
    ? await supabase.from("contracts").select(`${CONTRACT_LITE_FIELDS}, sale_id`).in("sale_id", listSaleIds).not("status", "in", "(cancelled,rejected)")
    : { data: [] };
  const saleContract = new Map((saleContracts ?? []).map((c) => [c.sale_id as string, c as unknown as ContractLite]));
  const shipBy = new Map<string, { service: string | null; tracking_number: string | null; tracking_url: string | null; state: string | null; state_description: string | null }>();
  for (const s of shipments ?? []) if (!shipBy.has(s.order_id as string) && classifyShipment(s) !== null) shipBy.set(s.order_id as string, s);

  return (
    <>
      <PageHeader
        title="Sprzedaż"
        sub={<>Zamówienia ze sklepów Shopify. Ostatni odczyt: {lastShop ? dateTime(lastShop.created_at) : "jeszcze nie było"}{lastShip ? <> · przesyłki: {dateTime(lastShip.created_at)}</> : null}.</>}
        actions={
          <>
            <Link className="btn" href="/druk/zamowienia" target="_blank">Drukuj nowe zamówienia</Link>
            {profile.role === "admin" && <form action={pullOrdersNow}><SubmitButton className="btn-secondary" pendingText="Pobieram…">Pobierz zamówienia teraz</SubmitButton></form>}
          </>
        }
      />
      <Tabs active="orders" fresh={fresh} />
      <Flash sp={sp} />
      {recentError && <div className="mb-4"><Notice tone="error">Odczyt zamówień z Shopify ({dateTime(recentError.created_at)}): {recentError.message}</Notice></div>}
      {cronStale && profile.role === "admin" && (
        <div className="mb-4"><Notice tone="error">
          Zadanie cykliczne nie odczytuje zamówień{lastShop ? ` od ${dateTime(lastShop.created_at)}` : ""} – nowe zamówienia przychodzą tylko wtedy, gdy aplikacja jest otwarta.
          Uruchom plik <b>supabase/cron.sql</b> w Supabase (SQL Editor) i sprawdź, czy w Vercel jest ustawiony <b>CRON_SECRET</b>. Do tego czasu użyj „Pobierz zamówienia teraz”.
        </Notice></div>
      )}
      {lastShip && !lastShip.ok && <div className="mb-4"><Notice tone="error">Odczyt przesyłek z Furgonetki nie udał się: {lastShip.message}</Notice></div>}
      {!!problems && <div className="mb-4"><Notice tone="error">{problems} {problems === 1 ? "linia zamówienia nie ma" : "linii zamówień nie ma"} sztuki na stanie. <Link className="font-medium underline" href="/sprzedaz?widok=linie&status=no_unit">Pokaż {problems === 1 ? "ją" : "je"}</Link> i przypisz sztukę skanem albo wygeneruj umowę.</Notice></div>}

      <div className="-mx-4 mb-3 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <nav className="segmented flex-nowrap whitespace-nowrap" aria-label="Sklep">
          {[...(storeList ?? []).map((x) => ({ id: x.id, name: x.name })), { id: "wszystkie", name: "Wszystkie sklepy" }].map((x) => (
            <Link key={x.id} href={`/sprzedaz?sklep=${x.id}${tab ? `&status=${tab}` : ""}`} aria-current={storeSel === x.id ? "page" : undefined}>{x.name}</Link>
          ))}
        </nav>
      </div>
      <nav className="-mx-4 mb-4 flex gap-1 overflow-x-auto whitespace-nowrap border-b border-line px-4 text-sm sm:mx-0 sm:flex-wrap sm:px-0" aria-label="Status zamówień">
        {ORDER_TABS.map((t, i) => (
          <Link
            key={t.key}
            href={withStore(t.key ? { status: t.key } : {})}
            className={`-mb-px border-b-2 px-3 py-2 ${tab === t.key ? "border-accent font-medium text-ink" : "border-transparent text-muted hover:text-ink"} ${t.key === "problem" && (counts[i].count ?? 0) > 0 ? "text-bad" : ""}`}
          >
            {t.label} <span className={`ml-1 rounded px-1.5 py-0.5 text-xs tabular-nums ${t.key === "problem" && (counts[i].count ?? 0) > 0 ? "bg-bad text-white" : "bg-panel"}`}>{counts[i].count ?? 0}</span>
          </Link>
        ))}
      </nav>

      <ListToolbar
        q={sp.q}
        placeholder="Numer zamówienia, klient albo e-mail"
        hidden={{ status: tab || undefined, sklep: sp.sklep }}
        sort={{ value: orderSort, options: Object.entries(ORDER_SORTS).map(([value, o]) => ({ value, label: o.label })) }}
        dirParam={null}
        active={activeFilters(sp, ["platnosc", "od", "do"])}
        resetHref={withStore(tab ? { status: tab } : {})}
        chips={filterChips("/sprzedaz", listParams, {
          q: (v) => `„${v}”`,
          platnosc: (v) => ({ pobranie: "za pobraniem", oplacone: "opłacone", nieoplacone: "nieopłacone" })[v],
          od: (v) => `od ${v}`,
          do: (v) => `do ${v}`,
        })}
      >
        <FilterField label="Płatność">
          <select className="input" name="platnosc" defaultValue={sp.platnosc ?? ""}>
            <option value="">Wszystkie</option>
            <option value="oplacone">Opłacone</option>
            <option value="pobranie">Za pobraniem</option>
            <option value="nieoplacone">Nieopłacone</option>
          </select>
        </FilterField>
        <FilterField label="Data zamówienia (od – do)" wide>
          <span className="flex items-center gap-1.5"><input className="input" type="date" name="od" defaultValue={sp.od} aria-label="Od" /><span className="text-muted">–</span><input className="input" type="date" name="do" defaultValue={sp.do} aria-label="Do" /></span>
        </FilterField>
      </ListToolbar>

      <Pagination page={page} total={count ?? 0} perPage={PER_PAGE} params={listParams} top />
      <div className="card overflow-x-auto 2xl:overflow-visible">
        <table className="table mtable" style={{ "--m-areas": "'order pay' 'date status' 'prod prod' 'ship ship' 'act act'" } as React.CSSProperties}>
          <thead><tr><th>Data</th><th>Zamówienie</th><th>Produkty</th><th>Wysyłka</th><th>Płatność</th><th>Status</th><th /></tr></thead>
          <tbody>
            {!orders?.length && (
              <tr><td colSpan={7} className="py-10 text-center text-muted">{tab || q ? "Brak zamówień." : "Zamówienia pojawią się po pierwszym odczycie ze Shopify (co 5 minut albo przyciskiem „Pobierz zamówienia teraz”)."}</td></tr>
            )}
            {orders?.map((o) => {
              const allLines = ((o.line_items ?? []) as LineItem[]).map((l, i) => ({ ...l, i }));
              // Pozycje wykluczone z magazynu (usługi itp.) – widoczne, gdy zamówienie ma tylko takie.
              const lines = allLines.some((l) => !l.service) ? allLines.filter((l) => !l.service) : allLines;
              const pay = paymentLabel(o);
              const oSales = salesBy.get(o.id) ?? [];
              const ship = shipBy.get(o.id);
              const shopTracking = ((o.fulfillments ?? []) as Fulfillment[]).flatMap((f) => f.trackingInfo).find((t) => t.number);
              const tracking = ship?.tracking_number ? { number: ship.tracking_number, url: ship.tracking_url } : shopTracking ? { number: shopTracking.number!, url: shopTracking.url } : null;
              const status = o.status as OrderStatus;
              return (
                <tr key={o.id} className={`group relative cursor-pointer transition-colors ${status === "problem" ? "bg-rose-50/60 hover:bg-rose-100/70" : "hover:bg-sky-50"}`}>
                  <td className="whitespace-nowrap text-muted max-md:text-xs" style={{ gridArea: "date" }}>{dateTime(o.ordered_at)}</td>
                  <td className="whitespace-nowrap" style={{ gridArea: "order" }}>
                    {/* Cały wiersz prowadzi do zamówienia (link rozciągnięty na wiersz); pozostałe linki są nad nim. */}
                    <Link className="font-medium text-accent after:absolute after:inset-0 after:content-[''] hover:underline" href={`/sprzedaz/${o.id}`}>{o.name}</Link>
                    <span className="block text-xs text-muted">{(o.store as unknown as { name: string } | null)?.name ?? ""}</span>
                    {isParOrder(o.shopify_order_id as string) && <span className="mt-0.5 inline-block rounded bg-violet-100 px-1.5 py-px text-[11px] font-semibold text-violet-800" title="Wysyłka z paragonu PAR – nie wchodzi do JPK">PAR · poza JPK</span>}
                    {o.customer_name && <span className="block text-xs">{o.customer_name}</span>}
                    <OrderPreview o={o as unknown as PreviewOrder} lines={lines} pay={pay} tracking={tracking} />
                  </td>
                  <td className="min-w-64 max-w-96" style={{ gridArea: "prod" }}>
                    {staffNote.get(o.id) && <p className="mb-1 line-clamp-2 rounded border border-red-300 bg-red-50 px-2 py-1 text-xs font-semibold text-red-800" title={staffNote.get(o.id) ?? ""}>Notatka: {staffNote.get(o.id)}</p>}
                    <ul className="space-y-0.5 text-sm max-md:rounded-lg max-md:bg-slate-50 max-md:px-2.5 max-md:py-2">
                      {lines.map((l) => (
                        <li key={l.id} className="flex items-baseline gap-2">
                          <span className="min-w-0 break-words">{l.title} · <b>{l.variant_title ?? "–"}</b>{l.quantity > 1 ? ` ×${l.quantity}` : ""}</span>
                          <WtbButton orderId={o.id} line={l.i} compact />
                        </li>
                      ))}
                    </ul>
                    <div className="mt-0.5 flex flex-wrap gap-1 font-mono text-xs">
                      {oSales.map((s, i) => s.unit
                        ? <Link key={i} className="relative z-10 text-accent hover:underline" href={`/magazyn/${s.unit.id}`}>{s.unit.code}</Link>
                        : s.status === "no_unit" && !FINISHED.has(status) ? <Pill key={i} tone="red">brak sztuki</Pill> : null)}
                    </div>
                  </td>
                  <td className="text-sm max-md:text-xs max-md:text-muted" style={{ gridArea: "ship" }}>
                    <span className="line-clamp-2">{o.shipping_method ?? "–"}</span>
                    {o.pickup_point && <span className="block font-mono text-xs text-muted">{o.pickup_point}</span>}
                    {tracking && (tracking.url
                      ? <a className="relative z-10 block font-mono text-xs text-accent hover:underline" href={tracking.url} target="_blank" rel="noreferrer">{tracking.number}</a>
                      : <span className="block font-mono text-xs">{tracking.number}</span>)}
                  </td>
                  <td className="whitespace-nowrap max-md:text-right" style={{ gridArea: "pay" }}>
                    <Pill tone={pay.tone}>{pay.text}</Pill>
                    <span className="block text-sm tabular-nums max-md:text-base max-md:font-semibold">{o.currency && o.currency !== "PLN" ? `${Number(o.total).toFixed(2)} ${o.currency}` : money(o.total)}</span>
                  </td>
                  <td className="max-w-56 max-md:text-right" style={{ gridArea: "status" }}>
                    <OrderStatusPill status={status} />
                    {o.status_detail && <span className={`mt-0.5 block text-xs ${status === "problem" ? "font-medium text-bad" : "text-muted"}`}>{o.status_detail}</span>}
                  </td>
                  <td style={{ gridArea: "act" }}>
                    <div className="flex flex-col items-start gap-1.5 max-md:flex-row max-md:flex-wrap max-md:items-center max-md:pt-1">
                      {!isParOrder(o.shopify_order_id as string) && <ContractAction pieces={matchPieces(o.id, (o.line_items ?? []) as LineItem[], oSales, (g) => variantOf.get(g))} saleContract={saleContract} cancelled={status === "cancelled"} back={`/sprzedaz${tab ? `?status=${tab}` : ""}`} />}
                      {status === "new" && <Link className="btn-secondary relative z-10 whitespace-nowrap px-2.5 py-1 text-xs" href={`/sprzedaz/${o.id}#etykieta`}>Utwórz etykietę</Link>}
                      {status !== "cancelled" && status !== "returned" && !isParOrder(o.shopify_order_id as string) && <ReceiptButton orderId={o.id} receiptId={o.receipt_id as number | null} job={jobOf.get(o.id) ?? null} printer={printer} compact />}
                      <WtbOrderButton orderId={o.id} inWtb={wtbOrders.has(o.id)} />
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

type PreviewOrder = {
  name: string; email: string | null; phone: string | null; note: string | null; customer_name: string | null; shipping_method: string | null; pickup_point: string | null;
  total: number | null; currency: string | null; status_detail: string | null;
  shipping_address: { name?: string | null; company?: string | null; address1?: string | null; address2?: string | null; zip?: string | null; city?: string | null; countryCodeV2?: string | null } | null;
};

/** Podgląd zamówienia po najechaniu na wiersz (tylko na dużym ekranie). */
function OrderPreview({ o, lines, pay, tracking }: { o: PreviewOrder; lines: (LineItem & { i: number })[]; pay: { text: string }; tracking: { number: string; url: string | null } | null }) {
  const a = o.shipping_address;
  return (
    <div role="tooltip" className="pointer-events-none invisible absolute left-24 top-full z-40 mt-1 hidden w-[30rem] rounded-lg border border-line bg-white p-3 text-sm opacity-0 shadow-xl transition-opacity delay-300 duration-150 group-hover:visible group-hover:opacity-100 lg:block">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="font-semibold">{o.name}</span>
        <span className="tabular-nums">{o.currency && o.currency !== "PLN" ? `${Number(o.total).toFixed(2)} ${o.currency}` : money(o.total)} · {pay.text}</span>
      </div>
      <ul className="mb-2 space-y-1.5">
        {lines.map((l) => (
          <li key={l.id} className="flex items-center gap-2">
            {l.image ? <img src={`${l.image}${l.image.includes("?") ? "&" : "?"}width=80`} alt="" className="h-10 w-10 flex-none rounded border border-line object-contain" /> : <span className="h-10 w-10 flex-none rounded bg-panel" />}
            <span className="min-w-0 flex-1"><span className="block break-words">{l.title}</span><span className="text-xs text-muted">{l.variant_title ?? "–"}{l.sku ? ` · ${l.sku}` : ""}</span></span>
            <span className="whitespace-nowrap tabular-nums">{l.quantity > 1 ? `${l.quantity} × ` : ""}{money(l.price)}</span>
          </li>
        ))}
      </ul>
      <div className="grid grid-cols-2 gap-3 border-t border-line pt-2 text-xs">
        <div>
          <div className="font-medium text-ink">{a?.name ?? o.customer_name ?? "–"}</div>
          {a?.company && <div>{a.company}</div>}
          {a && <div className="text-muted">{[a.address1, a.address2].filter(Boolean).join(", ")}<br />{[a.zip, a.city].filter(Boolean).join(" ")}{a.countryCodeV2 && a.countryCodeV2 !== "PL" ? `, ${a.countryCodeV2}` : ""}</div>}
          {o.phone && <div>{o.phone}</div>}
          {o.email && <div className="truncate">{o.email}</div>}
        </div>
        <div>
          <div className="font-medium text-ink">{o.shipping_method ?? "bez wysyłki"}</div>
          {o.pickup_point && <div className="font-mono">{o.pickup_point}</div>}
          {tracking && <div className="font-mono">{tracking.number}</div>}
          {o.status_detail && <div className="text-muted">{o.status_detail}</div>}
        </div>
      </div>
      {o.note && <p className="mt-2 rounded bg-panel p-1.5 text-xs"><b>Uwagi klienta:</b> {o.note}</p>}
    </div>
  );
}

function Flash({ sp }: { sp: Record<string, string | undefined> }) {
  if (!sp.ok && !sp.blad) return null;
  return <div className="mb-4">{sp.blad ? <Notice tone="error">{sp.blad}</Notice> : <Notice tone="ok">{sp.ok}</Notice>}</div>;
}

/** Linie sprzedaży: przypisanie sztuk, umowy, zamiana sztuki przy pakowaniu. */
async function SaleLines({ sp, page }: { sp: Record<string, string | undefined>; page: number }) {
  const { supabase } = await requireProfile();
  const status = sp.status ?? "";
  let query = supabase
    .from("sales")
    // „Brak sztuki” liczy tylko zamówienia jeszcze niewysłane (tak jak komunikat w Zamówieniach).
    .select(`${SALE_SELECT}, order:orders${status === "no_unit" ? "!inner" : ""}(status)`, { count: "exact" })
    .order("sold_at", { ascending: false })
    .range((page - 1) * PER_PAGE, page * PER_PAGE - 1);
  if (status === "no_unit") query = query.eq("status", status).not("order.status", "in", `(${[...FINISHED].join(",")})`);
  else if (status) query = query.eq("status", status);
  else query = query.neq("status", "unmatched");
  const saleQ = wordsOr(["order_ref", "product_name"], searchWords(sp.q));
  if (saleQ) query = query.or(saleQ);

  const [{ data: sales, count }, { data: lastSync }] = await Promise.all([
    query,
    supabase.from("sync_log").select("ok, message, created_at").eq("job", "base-orders").order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const saleIds = (sales ?? []).map((x) => x.id);
  const { data: pendingContracts } = saleIds.length
    ? await supabase.from("contracts").select("id, status, template, paid_at, source, number, doc_number, counterparty, amount, type, sale_id").in("sale_id", saleIds).not("status", "in", "(cancelled,rejected)")
    : { data: [] };
  const pendingBySale = new Map((pendingContracts ?? []).map((c) => [c.sale_id as string, c as unknown as ContractLite]));

  return (
    <>
      <PageHeader title="Sprzedaż" sub={<>Linie zamówień: aplikacja bierze najpierw Twoje sztuki, potem komis, zawsze od najstarszej. Ostatni odczyt: {lastSync ? `${dateTime(lastSync.created_at)}${lastSync.ok ? "" : " (błąd)"}` : "jeszcze nie było"}.</>} />
      <Tabs active="lines" />
      <ListToolbar
        q={sp.q}
        placeholder="Numer zamówienia"
        hidden={{ widok: "linie" }}
        active={status ? 1 : 0}
        defaultOpen={!!status}
        resetHref="/sprzedaz?widok=linie"
        chips={filterChips("/sprzedaz", { widok: "linie", q: sp.q, status }, { q: (v) => `„${v}”`, status: (v) => SALE_STATUS[v] })}
      >
        <FilterField label="Status linii">
          <select className="input" name="status" defaultValue={status}>
            <option value="">Wszystkie (bez niepowiązanych)</option>
            {Object.entries(SALE_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </FilterField>
      </ListToolbar>

      <Pagination page={page} total={count ?? 0} perPage={PER_PAGE} params={{ widok: "linie", q: sp.q, status: sp.status }} top />
      <div className="card overflow-x-auto">
        <table className="table mtable mtable-flow">
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
                  <td className="m-full">{variant ? <>{variant.product.title} · <b>{variant.option}</b></> : <span className="text-muted">{s.product_name}</span>}</td>
                  <td className="whitespace-nowrap"><UnitCell unit={s.unit as unknown as SaleUnit} /></td>
                  <td>{s.status === "no_unit" && FINISHED.has((s.order as unknown as { status: string } | null)?.status ?? "")
                    ? <Pill tone="slate">zamówienie wysłane</Pill>
                    : <Pill tone={s.status === "assigned" ? "green" : s.status === "cancelled" ? "slate" : "red"}>{SALE_STATUS[s.status]}</Pill>}</td>
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

/** Zamówienia wysłane / zakończone – brak sztuki z magazynu nie jest już problemem (także w JPK). */
const FINISHED = new Set(["shipped", "delivered", "returned", "cancelled"]);

/** Liczba nowych zamówień (licznik przy zakładce „Zamówienia”). */
async function newOrdersCount() {
  const { count } = await createAdminClient().from("orders").select("id", { count: "exact", head: true }).eq("status", "new");
  return count ?? 0;
}

async function Tabs({ active, fresh: known }: { active: "orders" | "lines" | "pos" | "faktury" | "jpk"; fresh?: number }) {
  const { profile } = await requireProfile();
  const cur = (on: boolean) => (on ? ("page" as const) : undefined);
  const sales = can(profile, "sprzedaz");
  const invoices = can(profile, "faktury");
  const fresh = !sales ? 0 : known ?? (await newOrdersCount());
  return (
    <div className="-mx-4 mb-5 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <nav className="segmented flex-nowrap whitespace-nowrap" aria-label="Sprzedaż">
        {sales && <Link href="/sprzedaz" aria-current={cur(active === "orders")}>Zamówienia{fresh ? <span className="ml-1.5 rounded-full bg-orange-500 px-1.5 py-px text-[11px] font-semibold tabular-nums text-white" title="Nowe zamówienia">{fresh}</span> : null}</Link>}
        {sales && <Link href="/sprzedaz?widok=stacjonarna" aria-current={cur(active === "pos")}>Stacjonarna</Link>}
        {invoices && <Link href="/sprzedaz?widok=faktury" aria-current={cur(active === "faktury")}>Faktury</Link>}
        {invoices && <Link href="/sprzedaz?widok=jpk" aria-current={cur(active === "jpk" || active === "lines")}>JPK</Link>}
      </nav>
    </div>
  );
}

const PAYMENT: Record<string, string> = { card: "karta", cash: "gotówka", blik: "BLIK", transfer: "przelew", other: "inna" };

const ORDER_SORTS: Record<string, { label: string; column: string; asc: boolean }> = {
  najnowsze: { label: "Najnowsze", column: "ordered_at", asc: false },
  najstarsze: { label: "Najstarsze", column: "ordered_at", asc: true },
  drozsze: { label: "Kwota: najwyższa", column: "total", asc: false },
  tansze: { label: "Kwota: najniższa", column: "total", asc: true },
  numer: { label: "Numer zamówienia", column: "number", asc: false },
};
const POS_SORTS: Record<string, { label: string; column: string; asc: boolean }> = {
  najnowsze: { label: "Najnowsze", column: "created_at", asc: false },
  najstarsze: { label: "Najstarsze", column: "created_at", asc: true },
  drozsze: { label: "Kwota: najwyższa", column: "total", asc: false },
  tansze: { label: "Kwota: najniższa", column: "total", asc: true },
};

async function PosList({ page, q, sp }: { page: number; q: string; sp: Record<string, string | undefined> }) {
  const { supabase, profile } = await requireProfile();
  const posSort = POS_SORTS[sp.sort ?? ""] ? sp.sort! : "najnowsze";
  let query = supabase
    .from("pos_orders")
    .select("id, code, total, payment_method, customer, created_at, base_sync_status, store:stores(name), items:pos_order_items(price, status, name, quantity, unit:units(id, code, identifier, owner_type, contract_id, variant:variants(option, product:products(title))))", { count: "exact" })
    .order(POS_SORTS[posSort].column, { ascending: POS_SORTS[posSort].asc })
    .range((page - 1) * PER_PAGE, page * PER_PAGE - 1);
  if (sp.sklep) query = query.eq("store_id", sp.sklep);
  if (sp.platnosc) query = query.eq("payment_method", sp.platnosc);
  const odR = warsawDayRange(sp.od), doR = warsawDayRange(sp.do);
  if (odR) query = query.gte("created_at", odR.from);
  if (doR) query = query.lt("created_at", doR.to);
  const { data: storeList } = await supabase.from("stores").select("id, name").order("name");
  const listParams = { widok: "stacjonarna", q: q || undefined, sklep: sp.sklep, platnosc: sp.platnosc, od: sp.od, do: sp.do, sort: sp.sort };
  const text = q.replace(/[%,()*\\]/g, " ").trim();
  if (text) {
    // Szukanie po nazwie przedmiotu, SKU, kodzie sztuki, IMEI, numerze sprzedaży albo kliencie.
    const words = searchWords(text);
    const { data: units } = await supabase.from("units_list").select("id")
      .or(wordsOr(["title", "style_sku", "code", "identifier", "base_sku"], words)!).limit(300);
    const unitIds = (units ?? []).map((u) => u.id as string);
    const [{ data: items }, { data: named }] = await Promise.all([
      unitIds.length ? supabase.from("pos_order_items").select("order_id").in("unit_id", unitIds).limit(500) : Promise.resolve({ data: [] as { order_id: string }[] }),
      supabase.from("pos_order_items").select("order_id").or(wordsOr(["name"], words)!).limit(200),
    ]);
    const orderIds = [...new Set([...(items ?? []), ...(named ?? [])].map((i) => i.order_id as string))];
    query = query.or(wordsOr(["code", "customer"], words, orderIds.length ? [`id.in.(${orderIds.slice(0, 150).join(",")})`] : [])!);
  }
  const { data, count } = await query;
  // Numery wydrukowanych paragonów fiskalnych (z drukarki).
  const posIds = (data ?? []).map((o) => o.id as string);
  const { data: rcpts } = posIds.length
    ? await supabase.from("receipts").select("pos_order_id, number, issued_at").in("pos_order_id", posIds).eq("source", "printer").order("issued_at")
    : { data: [] };
  const receiptOf = new Map<string, string[]>();
  for (const r of rcpts ?? []) if (r.pos_order_id && r.number) receiptOf.set(r.pos_order_id as string, [...(receiptOf.get(r.pos_order_id as string) ?? []), r.number as string]);
  type PosItem = { price: number; status: string; name: string | null; quantity: number | null; unit: { id: string; code: string; identifier: string | null; owner_type: string; contract_id: string | null; variant: { option: string; product: { title: string } } | null } | null };
  return (
    <>
      <PageHeader title="Sprzedaż" sub="Sprzedaż stacjonarna z kasy." actions={<Link className="btn" href="/kasa">Nowa sprzedaż</Link>} />
      <Tabs active="pos" />
      <Flash sp={sp} />
      {profile.role === "admin" && <CashDrawer />}
      <ListToolbar
        q={q}
        placeholder="Przedmiot, SKU, kod sztuki, IMEI, numer, klient"
        hidden={{ widok: "stacjonarna" }}
        sort={{ value: posSort, options: Object.entries(POS_SORTS).map(([value, o]) => ({ value, label: o.label })) }}
        dirParam={null}
        active={activeFilters(sp, ["sklep", "platnosc", "od", "do"])}
        resetHref="/sprzedaz?widok=stacjonarna"
        chips={filterChips("/sprzedaz", listParams, {
          q: (v) => `„${v}”`,
          sklep: (v) => storeList?.find((x) => x.id === v)?.name,
          platnosc: (v) => PAYMENT[v] ?? v,
          od: (v) => `od ${v}`,
          do: (v) => `do ${v}`,
        })}
      >
        <FilterField label="Sklep">
          <select className="input" name="sklep" defaultValue={sp.sklep ?? ""}>
            <option value="">Wszystkie sklepy</option>
            {storeList?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </FilterField>
        <FilterField label="Płatność">
          <select className="input" name="platnosc" defaultValue={sp.platnosc ?? ""}>
            <option value="">Wszystkie</option>
            {Object.entries(PAYMENT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </FilterField>
        <FilterField label="Data (od – do)" wide>
          <span className="flex items-center gap-1.5"><input className="input" type="date" name="od" defaultValue={sp.od} aria-label="Od" /><span className="text-muted">–</span><input className="input" type="date" name="do" defaultValue={sp.do} aria-label="Do" /></span>
        </FilterField>
      </ListToolbar>
      <Pagination page={page} total={count ?? 0} perPage={PER_PAGE} params={listParams} top />
      <div className="card overflow-x-auto">
        <table className="table mtable" style={{ "--m-areas": "'num total' 'date pay' 'items items' 'store state' 'del del'" } as React.CSSProperties}>
          <thead><tr><th>Data</th><th>Numer</th><th>Przedmioty</th><th>Sklep</th><th>Płatność</th><th className="text-right">Kwota</th><th>Stan</th>{profile.role === "admin" && <th />}</tr></thead>
          <tbody>
            {!data?.length && <tr><td colSpan={7} className="py-10 text-center text-muted">{q ? "Nic nie znaleziono." : "Brak sprzedaży stacjonarnej."}</td></tr>}
            {data?.map((o) => (
              <tr key={o.id}>
                <td className="whitespace-nowrap text-muted max-md:text-xs" style={{ gridArea: "date" }}>{dateTime(o.created_at)}</td>
                <td style={{ gridArea: "num" }}>
                  <Link className="font-medium text-accent hover:underline" href={`/kasa/${o.id}`}>{o.code}</Link>
                  {receiptOf.get(o.id)?.map((n) => <span key={n} className="block whitespace-nowrap text-xs" title="Numer paragonu fiskalnego z drukarki">paragon <b className="font-mono">{n}</b></span>)}
                  {o.customer && <span className="block text-xs text-muted">{o.customer}</span>}
                </td>
                <td className="min-w-64 max-w-96" style={{ gridArea: "items" }}>
                  <ul className="space-y-0.5 text-sm">
                    {((o.items ?? []) as unknown as PosItem[]).map((i, k) => (
                      <li key={k}>
                        <span className="break-words">{i.unit?.variant ? <>{i.unit.variant.product.title} · <b>{i.unit.variant.option}</b></> : i.name ? <>{i.name}{Number(i.quantity ?? 1) !== 1 ? ` × ${Number(i.quantity)}` : ""} <span className="text-xs text-muted">(spoza magazynu)</span></> : "–"} <span className="font-mono text-xs text-muted">{i.unit?.code}</span></span>
                        {i.unit?.owner_type === "consignment" && !i.unit.contract_id && i.status !== "returned" && <span className="block"><ConsignorWaiting /></span>}
                      </li>
                    ))}
                  </ul>
                </td>
                <td className="max-md:text-xs max-md:text-muted" style={{ gridArea: "store" }}>{(o.store as unknown as { name: string }).name}</td>
                <td className="max-md:text-right max-md:text-xs max-md:text-muted" style={{ gridArea: "pay" }}>{PAYMENT[o.payment_method] ?? o.payment_method}</td>
                <td className="text-right tabular-nums max-md:font-semibold" style={{ gridArea: "total" }}>{money(o.total)}</td>
                <td className="max-md:text-right" style={{ gridArea: "state" }}><Pill tone={o.base_sync_status === "ok" ? "green" : "red"}>{o.base_sync_status === "ok" ? "ok" : "do sprawdzenia"}</Pill></td>
                {profile.role === "admin" && (
                  <td style={{ gridArea: "del" }}>
                    <form action={deletePosOrder}>
                      <input type="hidden" name="id" value={o.id} />
                      <input type="hidden" name="back" value={`/sprzedaz?widok=stacjonarna${q ? `&q=${encodeURIComponent(q)}` : ""}`} />
                      <ConfirmSubmit className="text-sm text-bad hover:underline" message={`Usunąć sprzedaż ${o.code}? Sztuki wrócą na stan, paragon PDF (jeśli jest) zostanie anulowany. Wydrukowany paragon fiskalny zostaje w JPK.`}>Usuń</ConfirmSubmit>
                    </form>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination page={page} total={count ?? 0} perPage={PER_PAGE} params={listParams} />
    </>
  );
}

/**
 * Umowa przy zamówieniu, osobno dla każdego sprzedanego przedmiotu (1 umowa na przedmiot):
 * gotowa → „umowa ✓”; link wysłany / do zatwierdzenia / do opłacenia → „Umowa w toku” z podglądem;
 * rzecz komisanta bez umowy → „czeka na umowę od komisanta”; w pozostałych przypadkach „Dołącz umowę”
 * (wybór: gotowa umowa, umowa do podpisu albo skan).
 */
function ContractAction({ pieces, saleContract, cancelled, back }: {
  pieces: Piece<{ id: string; status: string; variant_id: string | null; unit: { id: string; contract_id: string | null; owner_type: string; contract: ContractLite | null } | null }>[];
  saleContract: Map<string, ContractLite>;
  cancelled: boolean;
  back: string;
}) {
  const live = pieces.filter((p) => p.sale?.status !== "cancelled");
  const rows = live.map((p) => {
    const c = p.sale?.unit?.contract ?? (p.sale ? saleContract.get(p.sale.id) : undefined) ?? null;
    const stage = c ? contractStage(c) : null;
    return { p, c, stage: stage === "dead" ? null : stage, consignment: p.sale?.unit?.owner_type === "consignment" };
  }).filter((r) => r.stage || r.consignment || r.p.sale?.unit || !cancelled);
  if (!rows.length) return null;
  if (rows.every((r) => isSettled(r.stage)) && rows.length === 1) return <ContractDone c={rows[0].c!} stage={rows[0].stage!} />;
  const many = rows.length > 1;
  const btn = `${MISSING_BTN} relative z-10`;
  return (
    <>
      {rows.map(({ p, c, stage, consignment }) => {
        const tag = many ? <span className="block max-w-40 truncate text-[11px] text-muted">{p.line.variant_title ?? p.line.title}</span> : null;
        if (c && isSettled(stage)) return <span key={p.ref} className="relative z-10">{tag}<ContractDone c={c} stage={stage!} /></span>;
        if (c && stage) return <span key={p.ref} className="relative z-10">{tag}<ContractInProgress c={c} stage={stage} /></span>;
        if (consignment) return <span key={p.ref} className="relative z-10 block">{tag}<ConsignorWaiting /></span>;
        return (
          <form key={p.ref} action={attachContractForPiece} className="relative z-10">
            <input type="hidden" name="back" value={back} />
            <button className={btn} name="umowa_dla" value={p.ref} title={`${p.line.title} ${p.line.variant_title ?? ""}`}>
              Dołącz umowę{many ? ` · ${p.line.variant_title ?? p.line.title.slice(0, 14)}` : ""}
            </button>
          </form>
        );
      })}
    </>
  );
}
