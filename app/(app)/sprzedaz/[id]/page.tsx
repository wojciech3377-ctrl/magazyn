import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { dateTime, money, SALE_STATUS } from "@/lib/labels";
import { Notice, PageHeader, Pill } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { furgonetkaConfigured, furgonetkaConnection } from "@/lib/integrations/furgonetka";
import { classifyShipment, guessService, paymentLabel, type Fulfillment, type OrderStatus } from "@/lib/orders/status";
import type { LineItem } from "@/lib/sync/shop-orders";
import { OrderStatusPill, SALE_SELECT, SaleContract, UnitCell, type SaleUnit } from "../SaleBits";
import { SwapForm } from "../SwapForm";
import { LabelForm } from "./LabelForm";
import { OrderOps } from "./OrderOps";
import { WtbButton } from "@/components/WtbButton";
import { ReceiptButton } from "@/components/ReceiptButton";
import { refreshOrder } from "./actions";

type Address = { name: string | null; company: string | null; address1: string | null; address2: string | null; city: string | null; zip: string | null; countryCodeV2: string | null; phone: string | null } | null;

function shopifyAdminUrl(domain: string | null, legacyId: string | null) {
  if (!domain || !legacyId) return null;
  return `https://admin.shopify.com/store/${domain.replace(/\.myshopify\.com$/, "")}/orders/${legacyId}`;
}

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase, profile } = await requireProfile();
  const { data: order } = await supabase.from("orders").select("*, store:stores(name, code, shopify_domain)").eq("id", id).maybeSingle();
  if (!order) notFound();

  const [{ data: shipments }, { data: sales }] = await Promise.all([
    supabase.from("shipments").select("*").eq("order_id", id).order("created_at", { ascending: false }),
    supabase.from("sales").select(SALE_SELECT).eq("order_id", id).order("sold_at"),
  ]);
  const saleIds = (sales ?? []).map((s) => s.id);
  const { data: pendingContracts } = saleIds.length
    ? await supabase.from("contracts").select("id, status, sale_id").in("sale_id", saleIds).not("status", "in", "(cancelled,rejected)")
    : { data: [] };
  const pendingBySale = new Map((pendingContracts ?? []).map((c) => [c.sale_id as string, c]));
  const furgonetkaReady = furgonetkaConfigured() && !!(await furgonetkaConnection(createAdminClient()));
  const { data: invoice } = await supabase.from("invoices").select("id, number").eq("order_id", id).not("status", "in", "(rejected,cancelled)").limit(1).maybeSingle();

  const store = order.store as { name: string; code: string; shopify_domain: string | null } | null;
  const addr = order.shipping_address as Address;
  const lines = (order.line_items ?? []) as LineItem[];
  const fulfillments = (order.fulfillments ?? []) as Fulfillment[];
  const pay = paymentLabel(order);
  const status = order.status as OrderStatus;
  const activeShipments = (shipments ?? []).filter((s) => classifyShipment(s) !== null);
  const shopUrl = shopifyAdminUrl(store?.shopify_domain ?? null, order.shopify_legacy_id);

  return (
    <>
      <PageHeader
        title={`Zamówienie ${order.name}`}
        sub={<>{store?.name} · {dateTime(order.ordered_at)}</>}
        actions={
          <>
            {status !== "cancelled" && status !== "returned" && <ReceiptButton orderId={order.id} receiptId={order.receipt_id} />}
            {invoice
              ? <Link className="btn-secondary" href={`/sprzedaz/faktury/${invoice.id}`}>Faktura {invoice.number}</Link>
              : status !== "cancelled" && <Link className="btn-secondary" href={`/sprzedaz/faktury/nowa?zamowienie=${order.id}`}>Wystaw fakturę</Link>}
            <a className="btn-secondary" href="#etykieta">Utwórz etykietę</a>
            <form action={refreshOrder}><input type="hidden" name="id" value={order.id} /><SubmitButton className="btn-secondary" pendingText="Odświeżam…">Odśwież</SubmitButton></form>
            {shopUrl && <a className="btn-secondary" href={shopUrl} target="_blank" rel="noreferrer">Otwórz w Shopify</a>}
            <Link className="btn-secondary" href="/sprzedaz">Wróć do listy</Link>
          </>
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <OrderStatusPill status={status} />
        {order.status_detail && <span className={`text-sm ${status === "problem" ? "font-medium text-bad" : "text-muted"}`}>{order.status_detail}</span>}
        <span className="mx-1 text-line">|</span>
        <Pill tone={pay.tone}>{pay.text}</Pill>
        <span className="text-sm font-medium tabular-nums">{money(order.total)}</span>
        {order.cod && Number(order.outstanding) > 0 && <span className="text-sm text-muted">do pobrania {money(order.outstanding)}</span>}
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <section className="card p-4">
          <h2 className="h2 mb-3">Klient</h2>
          <dl className="space-y-1.5 text-sm">
            <div className="font-medium">{order.customer_name ?? "–"}</div>
            {addr?.company && <div>{addr.company}</div>}
            {addr && <div className="text-muted">{[addr.address1, addr.address2].filter(Boolean).join(", ")}<br />{[addr.zip, addr.city].filter(Boolean).join(" ")}{addr.countryCodeV2 && addr.countryCodeV2 !== "PL" ? `, ${addr.countryCodeV2}` : ""}</div>}
            {order.phone && <div><a className="text-accent hover:underline" href={`tel:${order.phone}`}>{order.phone}</a></div>}
            {order.email && <div><a className="text-accent hover:underline" href={`mailto:${order.email}`}>{order.email}</a></div>}
          </dl>
          {order.note && <p className="mt-3 rounded-md bg-panel p-2 text-sm"><b>Uwagi klienta:</b> {order.note}</p>}
        </section>

        <section className="card p-4">
          <h2 className="h2 mb-3">Wysyłka</h2>
          <div className="space-y-1.5 text-sm">
            <div className="font-medium">{order.shipping_method ?? "bez wysyłki"}{order.shipping_price != null && <span className="font-normal text-muted"> · {money(order.shipping_price)}</span>}</div>
            {order.pickup_point && <div>Punkt odbioru: <b className="font-mono">{order.pickup_point}</b></div>}
            {(order.attributes as { key: string; value: string | null }[]).filter((a) => a.value).map((a) => (
              <div key={a.key} className="text-muted">{a.key}: {a.value}</div>
            ))}
          </div>
          <ul className="mt-3 space-y-2">
            {(shipments ?? []).map((s) => (
              <li key={s.id} className="rounded-md border border-line p-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium uppercase">{s.service ?? "przesyłka"}</span>
                  {s.tracking_url ? <a className="font-mono text-accent hover:underline" href={s.tracking_url} target="_blank" rel="noreferrer">{s.tracking_number ?? "śledzenie"}</a> : <span className="font-mono">{s.tracking_number ?? "numer w drodze…"}</span>}
                  {classifyShipment(s) === null && <Pill>anulowana</Pill>}
                </div>
                {s.state_description && <div className={classifyShipment(s) === "problem" ? "font-medium text-bad" : "text-muted"}>{s.state_description}{s.state_at ? ` · ${dateTime(s.state_at)}` : ""}</div>}
                <a className="mt-1 inline-block text-xs text-accent hover:underline" href={`/api/etykiety/${s.id}`} target="_blank" rel="noreferrer">Etykieta PDF</a>
              </li>
            ))}
            {fulfillments.flatMap((f) => f.trackingInfo.filter((t) => t.number && !(shipments ?? []).some((s) => s.tracking_number === t.number)).map((t) => (
              <li key={t.number!} className="rounded-md border border-line p-2 text-sm">
                <span className="font-medium">{t.company ?? "Przesyłka"}</span>{" "}
                {t.url ? <a className="font-mono text-accent hover:underline" href={t.url} target="_blank" rel="noreferrer">{t.number}</a> : <span className="font-mono">{t.number}</span>}
                <span className="block text-xs text-muted">z Shopify{f.displayStatus ? ` · ${f.displayStatus.toLowerCase().replace(/_/g, " ")}` : ""}</span>
              </li>
            )))}
          </ul>
        </section>

        <section className="card p-4">
          <h2 className="h2 mb-3">Płatność</h2>
          <div className="space-y-1.5 text-sm">
            <div><Pill tone={pay.tone}>{pay.text}</Pill></div>
            <div className="text-muted">{order.payment_gateways?.length ? order.payment_gateways.join(", ") : "–"}</div>
            <div>Razem: <b className="tabular-nums">{money(order.total)}</b>{order.currency && order.currency !== "PLN" ? ` ${order.currency}` : ""}</div>
            {Number(order.outstanding) > 0 && <div>Do zapłaty: <b className="tabular-nums">{money(order.outstanding)}</b></div>}
          </div>
        </section>
      </div>

      <section className="card mt-5 overflow-x-auto">
        <h2 className="h2 p-4 pb-0">Produkty</h2>
        <table className="table">
          <thead><tr><th /><th>Produkt</th><th>Rozmiar</th><th>SKU</th><th className="text-right">Ilość</th><th className="text-right">Cena</th><th /></tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.id} className={l.service ? "text-muted" : ""}>
                <td className="w-14">{l.image ? <img src={`${l.image}${l.image.includes("?") ? "&" : "?"}width=96`} alt="" className="h-12 w-12 rounded object-contain" /> : null}</td>
                <td>{l.title}{l.service && <span className="ml-1 text-xs">(usługa)</span>}</td>
                <td className="font-medium">{l.variant_title ?? "–"}</td>
                <td className="font-mono text-xs">{l.sku ?? "–"}</td>
                <td className="text-right tabular-nums">{l.quantity}</td>
                <td className="text-right tabular-nums">{money(l.price)}</td>
                <td>{!l.service && <WtbButton orderId={order.id} line={i} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card mt-5 overflow-x-auto">
        <h2 className="h2 p-4 pb-0">Sztuki z magazynu</h2>
        {!sales?.length ? (
          <p className="p-4 text-sm text-muted">Linie z magazynu pojawią się po odczycie zamówień z Base (co 5 minut).</p>
        ) : (
          <table className="table">
            <thead><tr><th>Produkt</th><th>Sztuka</th><th>Status</th><th>Umowa</th><th>Zmień sztukę przy pakowaniu</th></tr></thead>
            <tbody>
              {sales.map((s) => {
                const variant = s.variant as unknown as { option: string; product: { title: string } } | null;
                return (
                  <tr key={s.id}>
                    <td>{variant ? <>{variant.product.title} · <b>{variant.option}</b></> : <span className="text-muted">{s.product_name}</span>}</td>
                    <td className="whitespace-nowrap"><UnitCell unit={s.unit as unknown as SaleUnit} /></td>
                    <td><Pill tone={s.status === "assigned" ? "green" : s.status === "cancelled" ? "slate" : "red"}>{SALE_STATUS[s.status]}</Pill></td>
                    <td className="whitespace-nowrap"><SaleContract saleId={s.id} status={s.status} hasVariant={!!s.variant_id} unit={s.unit as unknown as SaleUnit} pending={pendingBySale.get(s.id)} /></td>
                    <td>{s.status !== "cancelled" && s.status !== "unmatched" && <SwapForm saleId={s.id} />}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section id="etykieta" className="card mt-5 p-4">
        <h2 className="h2 mb-3">Etykieta</h2>
        {status === "cancelled" ? (
          <Notice>Zamówienie anulowane.</Notice>
        ) : !furgonetkaReady ? (
          <Notice>Do tworzenia etykiet połącz aplikację z Furgonetką: <Link className="underline" href="/ustawienia?zakladka=wysylka">Ustawienia → Wysyłka</Link>.</Notice>
        ) : (
          <>
            {activeShipments.length > 0 && <p className="mb-3 text-sm text-warn">To zamówienie ma już przesyłkę. Kolejną etykietę twórz tylko, gdy wysyłasz drugą paczkę.</p>}
            <LabelForm
              d={{
                orderId: order.id,
                service: guessService(order.shipping_method) ?? "inpost_locker",
                point: order.pickup_point ?? "",
                name: addr?.name ?? order.customer_name ?? "",
                company: addr?.company ?? "",
                street: [addr?.address1, addr?.address2].filter(Boolean).join(" "),
                postcode: addr?.zip ?? "",
                city: addr?.city ?? "",
                country: addr?.countryCodeV2 ?? "PL",
                email: order.email ?? "",
                phone: addr?.phone ?? order.phone ?? "",
                value: Number(order.total ?? 0),
                cod: order.cod && order.financial_status !== "PAID" ? Number(order.outstanding ?? order.total ?? 0) : 0,
                description: store?.code?.includes("telefon") ? "Telefon" : "Buty",
              }}
            />
          </>
        )}
      </section>
      {profile.role === "admin" && (status !== "cancelled" || fulfillments.length > 0) && (
        <section className="card mt-5 p-4">
          <h2 className="h2 mb-1">Anulowanie i zwrot</h2>
          <p className="mb-3 text-sm text-muted">Zmiana trafia do Shopify (zwrot pieniędzy, e-mail do klienta), a sztuki wracają na stan w magazynie.</p>
          <OrderOps
            orderId={order.id}
            lines={lines.filter((l) => !l.service).map((l) => ({ id: l.id, title: l.title, variant_title: l.variant_title, quantity: l.quantity }))}
            paid={["PAID", "PARTIALLY_REFUNDED", "PARTIALLY_PAID"].includes(String(order.financial_status ?? "").toUpperCase())}
            hasLabels={activeShipments.length > 0}
            canCancel={status !== "cancelled" && status !== "returned"}
            canReturn={fulfillments.length > 0 && status !== "returned"}
          />
        </section>
      )}
    </>
  );
}
