import Link from "next/link";
import { consignorBalance, consignorContracts, consignorUnits, consignmentFee, defaultAddress, requireConsignor, SHIPMENT_METHOD, SHIPMENT_STATUS, type ConsignorContract, type ConsignorShipment } from "@/lib/consignment";
import { SoldList, type SoldRow } from "./SoldList";
import { dateOnly, dateTime, money } from "@/lib/labels";
import { Pill } from "@/components/ui";
import { ShipRequestForm } from "./ShipRequestForm";
import { cancelShipmentByConsignor } from "./actions";

export const metadata = { title: "Panel komisanta" };

const STATUS: Record<string, { text: string; tone: "green" | "blue" | "amber" | "slate" }> = {
  in_stock: { text: "na stanie", tone: "green" },
  in_transit: { text: "w drodze do nas", tone: "blue" },
  reserved: { text: "zarezerwowana", tone: "amber" },
  consignor_hold: { text: "odłożona do wysyłki do Ciebie", tone: "amber" },
  sold: { text: "sprzedana", tone: "slate" },
  shipped: { text: "sprzedana", tone: "slate" },
  returned: { text: "zwrot od klienta", tone: "amber" },
  consignor_returned: { text: "odesłana do Ciebie", tone: "slate" },
  removed: { text: "wycofana", tone: "slate" },
};

function docOf(c: ConsignorContract | undefined): SoldRow["doc"] {
  if (!c || c.status === "cancelled" || c.status === "rejected") return { kind: "none" };
  if (c.status === "sent") {
    const live = c.source === "consignor" && c.sign_token && (!c.sign_expires_at || new Date(c.sign_expires_at) > new Date());
    return live ? { kind: "sign", href: `/podpis/${c.sign_token}` } : c.source === "consignor" ? { kind: "none" } : { kind: "sign", href: null };
  }
  if (c.status === "signed" && c.template) return { kind: "approve" };
  return { kind: "done", label: c.type === "invoice" ? `faktura ${c.doc_number ?? ""}`.trim() : `umowa${c.number ? ` nr ${c.number}` : ""}` };
}

export default async function KomisPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const tab = sp.zakladka === "sprzedane" ? "sprzedane" : "aktywne";
  const { db, consignor } = await requireConsignor();
  const units = await consignorUnits(db, consignor.id);
  const [bal, fee, { data: shipments }] = await Promise.all([
    consignorBalance(db, consignor.id, units),
    consignmentFee(db),
    db.from("consignor_shipments").select("*").eq("consignor_id", consignor.id).order("created_at", { ascending: false }).limit(30),
  ]);
  const onStock = units.filter((u) => ["in_stock", "in_transit", "reserved", "consignor_hold"].includes(u.status));
  const sold = units.filter((u) => ["sold", "shipped"].includes(u.status));
  const contracts = await consignorContracts(db, consignor.id, sold.map((u) => u.id));
  const soldRows: SoldRow[] = sold.map((u) => ({
    id: u.id, code: u.code, title: u.title, option: u.option, price: u.payout_amount, soldAt: dateOnly(u.sold_at), hasDocument: u.has_document,
    doc: docOf(contracts.get(u.id)),
  }));
  const missing = soldRows.filter((r) => r.doc.kind === "none").length;
  const codeOf = new Map(units.map((u) => [u.id, `${u.title} ${u.option}`]));
  const addr = defaultAddress(consignor);

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold">{consignor.name}</h1>
      <p className="mb-5 text-sm text-muted">Twoje rzeczy w komisie, sprzedaż i wypłaty. Rzecz liczy się do wypłaty, gdy wystawimy do niej paragon albo fakturę.</p>

      <div className="mb-6 grid gap-3 sm:grid-cols-4">
        {[
          ["Na stanie", String(onStock.length)],
          ["Sprzedane", String(sold.length)],
          ["Wypłacone", money(bal.paid)],
          ["Do wypłaty", money(bal.balance)],
        ].map(([label, value], i) => (
          <div key={label} className={`card p-4 ${i === 3 ? "border-emerald-300 bg-emerald-50" : ""}`}>
            <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
          </div>
        ))}
      </div>

      <nav className="mb-5 flex gap-1 border-b border-line text-sm" aria-label="Zakładki">
        <Link href="/komis" className={`-mb-px border-b-2 px-3 py-2 ${tab === "aktywne" ? "border-accent font-medium text-ink" : "border-transparent text-muted hover:text-ink"}`}>Aktywne <span className="ml-1 rounded bg-panel px-1.5 py-0.5 text-xs tabular-nums">{onStock.length}</span></Link>
        <Link href="/komis?zakladka=sprzedane" className={`-mb-px border-b-2 px-3 py-2 ${tab === "sprzedane" ? "border-accent font-medium text-ink" : "border-transparent text-muted hover:text-ink"}`}>
          Sprzedane <span className={`ml-1 rounded px-1.5 py-0.5 text-xs tabular-nums ${missing ? "bg-bad text-white" : "bg-panel"}`}>{missing ? `${missing} bez umowy` : sold.length}</span>
        </Link>
      </nav>

      {tab === "aktywne" && missing > 0 && (
        <div className="mb-5 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
          Masz sprzedane rzeczy bez umowy ({missing}). <Link className="font-medium text-accent underline" href="/komis?zakladka=sprzedane">Dołącz umowę albo fakturę</Link>
        </div>
      )}

      {tab === "aktywne" && <>
      <section className="mb-6">
        <h2 className="h2 mb-2">Twoje rzeczy na stanie</h2>
        <ShipRequestForm
          units={onStock.map((u) => ({ id: u.id, code: u.code, title: u.title, option: u.option, status: u.status, price: u.payout_amount, received: dateOnly(u.received_at) }))}
          address={addr}
          fee={fee}
        />
      </section>

      <section className="mb-6">
        <h2 className="h2 mb-2">Zlecenia wysyłki do Ciebie</h2>
        <div className="card overflow-x-auto">
          <table className="table">
            <thead><tr><th>Data</th><th>Rzeczy</th><th>Sposób</th><th>Status</th><th /></tr></thead>
            <tbody>
              {!shipments?.length && <tr><td colSpan={5} className="py-6 text-center text-muted">Brak zleceń.</td></tr>}
              {((shipments ?? []) as ConsignorShipment[]).map((s) => (
                <tr key={s.id}>
                  <td className="whitespace-nowrap text-sm text-muted">{dateTime(s.created_at)}</td>
                  <td className="text-sm">{s.unit_ids.map((id) => codeOf.get(id) ?? "?").join(", ")}</td>
                  <td className="text-sm">{SHIPMENT_METHOD[s.method]}{s.shipping_fee ? ` · ${money(s.shipping_fee)}` : ""}{s.address ? <span className="block text-xs text-muted">{s.address.name}, {s.address.street}, {s.address.postcode} {s.address.city}</span> : null}</td>
                  <td><Pill tone={s.status === "shipped" ? "green" : s.status === "cancelled" ? "slate" : "amber"}>{SHIPMENT_STATUS[s.status]}</Pill>{s.tracking && <span className="block font-mono text-xs">{s.tracking}</span>}</td>
                  <td>{s.status === "requested" && <form action={cancelShipmentByConsignor}><input type="hidden" name="id" value={s.id} /><button className="text-sm text-bad hover:underline">Anuluj</button></form>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      </>}

      {tab === "sprzedane" && <>
      <section className="mb-6">
        <h2 className="h2 mb-2">Sprzedane</h2>
        <SoldList rows={soldRows} />
      </section>

      {bal.payouts.length > 0 && (
        <section>
          <h2 className="h2 mb-2">Wypłaty</h2>
          <div className="card overflow-x-auto">
            <table className="table">
              <thead><tr><th>Data</th><th className="text-right">Kwota</th><th>Opis</th></tr></thead>
              <tbody>
                {bal.payouts.map((p) => (
                  <tr key={p.id}><td className="text-sm">{dateOnly(p.paid_at)}</td><td className="text-right tabular-nums">{money(p.amount)}</td><td className="text-sm text-muted">{p.note}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      </>}
    </>
  );
}
