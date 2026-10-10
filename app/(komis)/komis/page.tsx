import { consignorBalance, consignorUnits, consignmentFee, defaultAddress, requireConsignor, SHIPMENT_METHOD, SHIPMENT_STATUS, type ConsignorShipment } from "@/lib/consignment";
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

export default async function KomisPage() {
  const { db, consignor } = await requireConsignor();
  const units = await consignorUnits(db, consignor.id);
  const [bal, fee, { data: shipments }] = await Promise.all([
    consignorBalance(db, consignor.id, units),
    consignmentFee(db),
    db.from("consignor_shipments").select("*").eq("consignor_id", consignor.id).order("created_at", { ascending: false }).limit(30),
  ]);
  const onStock = units.filter((u) => ["in_stock", "in_transit", "reserved", "consignor_hold"].includes(u.status));
  const sold = units.filter((u) => ["sold", "shipped"].includes(u.status));
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

      <section className="mb-6">
        <h2 className="h2 mb-2">Sprzedane</h2>
        <div className="card overflow-x-auto">
          <table className="table">
            <thead><tr><th>Rzecz</th><th>Data sprzedaży</th><th className="text-right">Twoja kwota</th><th>Rozliczenie</th></tr></thead>
            <tbody>
              {!sold.length && <tr><td colSpan={4} className="py-6 text-center text-muted">Jeszcze nic nie sprzedaliśmy.</td></tr>}
              {sold.map((u) => (
                <tr key={u.id}>
                  <td>{u.title} · <b>{u.option}</b> <span className="font-mono text-xs text-muted">{u.code}</span></td>
                  <td className="text-sm text-muted">{dateOnly(u.sold_at)}</td>
                  <td className="text-right tabular-nums">{money(u.payout_amount)}</td>
                  <td>{u.has_document ? <Pill tone="green">do wypłaty</Pill> : <Pill tone="amber">czeka na paragon / fakturę</Pill>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
    </>
  );
}
