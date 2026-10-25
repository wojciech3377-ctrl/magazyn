import Link from "next/link";
import { consignorBalance, consignorContracts, consignorUnits, consignmentFee, defaultAddress, requireConsignor, SHIPMENT_METHOD, SHIPMENT_STATUS, type ConsignorContract, type ConsignorShipment } from "@/lib/consignment";
import { SoldList, type SoldRow } from "./SoldList";
import { IntakeForm } from "./IntakeForm";
import { IntakeList, type IntakeCard } from "./IntakeList";
import { mergeIntakes } from "./intake-actions";
import { INTAKE_STATUS, ITEM_STATUS, type Intake, type IntakeItem } from "@/lib/intake";
import { dateOnly, dateTime, money } from "@/lib/labels";
import { Notice, Pill } from "@/components/ui";
import { ShipRequestForm } from "./ShipRequestForm";
import { InstallGuide } from "./InstallGuide";
import { cancelShipmentByConsignor } from "./actions";
import { consignorTimeline, describeEvent } from "@/lib/history";

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
    // Niepodpisana umowa komisanta (np. wysłana automatycznie po sprzedaży) – można ją podpisać albo zamiast niej wgrać fakturę.
    return live ? { kind: "sign", href: `/podpis/${c.sign_token}`, swappable: true } : c.source === "consignor" ? { kind: "none" } : { kind: "sign", href: null };
  }
  if (c.status === "signed") return { kind: "approve" };
  return { kind: "done", label: c.type === "invoice" ? `faktura ${c.doc_number ?? ""}`.trim() : `umowa${c.number ? ` NR${c.number}` : ""}` };
}

export default async function KomisPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const tab = sp.zakladka === "sprzedane" ? "sprzedane" : sp.zakladka === "wyslij" ? "wyslij" : sp.zakladka === "historia" ? "historia" : "aktywne";
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
  const paidIds = new Set<string>();
  for (let i = 0; i < sold.length; i += 200) {
    const { data } = await db.from("units").select("id").in("id", sold.slice(i, i + 200).map((u) => u.id)).eq("consignor_id", consignor.id).not("consignor_payout_id", "is", null);
    for (const r of data ?? []) paidIds.add(r.id as string);
  }
  const soldRows: SoldRow[] = sold.map((u) => ({
    id: u.id, code: u.code, title: u.title, option: u.option, price: u.payout_amount, soldAt: dateOnly(u.sold_at), hasDocument: u.has_document, paid: paidIds.has(u.id),
    doc: docOf(contracts.get(u.id)),
  }));
  const missing = soldRows.filter((r) => r.doc.kind === "none").length;
  const codeOf = new Map(units.map((u) => [u.id, `${u.title} ${u.option}`]));
  const [{ data: locs }, { data: intakeRows }] = await Promise.all([
    db.from("locations").select("id, name, ship_address, store:stores(name)").eq("active", true).order("name"),
    db.from("consignor_intakes").select("*, items:consignor_intake_items(*)").eq("consignor_id", consignor.id).order("created_at", { ascending: false }).limit(30),
  ]);
  const locLabel = new Map((locs ?? []).map((l) => [l.id as string, { label: `${(l.store as unknown as { name: string } | null)?.name ?? ""} · ${l.name}`, address: (l.ship_address as string | null) ?? null }]));
  const intakes: IntakeCard[] = ((intakeRows ?? []) as (Intake & { items: IntakeItem[] })[]).map((i) => ({
    id: i.id, status: i.status, statusText: INTAKE_STATUS[i.status].text, tone: INTAKE_STATUS[i.status].tone, created: dateOnly(i.created_at),
    location: locLabel.get(i.location_id)?.label ?? "", address: locLabel.get(i.location_id)?.address ?? null, tracking: i.tracking, carrier: i.carrier,
    items: [...i.items].sort((a, b) => a.position - b.position).map((x) => ({
      id: x.id, title: x.title, option: x.option, form: x.purchase_form === "vat_23" ? "VAT 23%" : "VAT marża", proposed: Number(x.proposed_price), offer: x.offer_price === null ? null : Number(x.offer_price),
      final: x.final_price === null ? null : Number(x.final_price), status: x.status, statusText: ITEM_STATUS[x.status],
    })),
  }));
  const waitingOnMe = intakes.filter((i) => i.status === "offer" || i.status === "to_send").length;
  const addr = defaultAddress(consignor);

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold">{consignor.name}</h1>
      {sp.ok && <div className="mb-4"><Notice tone="ok">{sp.ok}</Notice></div>}
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

      <InstallGuide />

      <nav className="mb-5 flex gap-1 border-b border-line text-sm" aria-label="Zakładki">
        <Link href="/komis" className={`-mb-px border-b-2 px-3 py-2 ${tab === "aktywne" ? "border-accent font-medium text-ink" : "border-transparent text-muted hover:text-ink"}`}>Aktywne <span className="ml-1 rounded bg-panel px-1.5 py-0.5 text-xs tabular-nums">{onStock.length}</span></Link>
        <Link href="/komis?zakladka=sprzedane" className={`-mb-px border-b-2 px-3 py-2 ${tab === "sprzedane" ? "border-accent font-medium text-ink" : "border-transparent text-muted hover:text-ink"}`}>
          Sprzedane <span className={`ml-1 rounded px-1.5 py-0.5 text-xs tabular-nums ${missing ? "bg-bad text-white" : "bg-panel"}`}>{missing ? `${missing} bez umowy` : sold.length}</span>
        </Link>
        <Link href="/komis?zakladka=wyslij" className={`-mb-px border-b-2 px-3 py-2 ${tab === "wyslij" ? "border-accent font-medium text-ink" : "border-transparent text-muted hover:text-ink"}`}>
          Wyślij do nas {waitingOnMe > 0 && <span className="ml-1 rounded bg-bad px-1.5 py-0.5 text-xs text-white">{waitingOnMe} do zrobienia</span>}
        </Link>
        <Link href="/komis?zakladka=historia" className={`-mb-px border-b-2 px-3 py-2 ${tab === "historia" ? "border-accent font-medium text-ink" : "border-transparent text-muted hover:text-ink"}`}>Historia</Link>
      </nav>

      {tab === "historia" && <History rows={await consignorTimeline(db, consignor.id, units.map((u) => ({ id: u.id, code: u.code, title: u.title, option: u.option, status: u.status, received_at: u.received_at })))} />}

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
          <table className="table mtable mtable-flow">
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

      {tab === "wyslij" && (
        <>
          <section className="mb-6">
            <h2 className="h2 mb-1">Zgłoś rzeczy do wysłania</h2>
            <p className="mb-3 text-sm text-muted">Dodaj rzeczy i swoją kwotę. Sprawdzimy zgłoszenie i odpiszemy e-mailem – po akceptacji wyślesz paczkę i wpiszesz numer przesyłki.</p>
            <IntakeForm locations={(locs ?? []).map((l) => ({ id: l.id as string, label: locLabel.get(l.id as string)!.label, address: locLabel.get(l.id as string)!.address }))} />
          </section>
          <section className="mb-6">
            <h2 className="h2 mb-2">Twoje zgłoszenia i paczki</h2>
            {(() => {
              const groups = new Map<string, IntakeCard[]>();
              for (const i of intakes.filter((x) => x.status === "to_send")) groups.set(i.location, [...(groups.get(i.location) ?? []), i]);
              return [...groups.entries()].filter(([, g]) => g.length > 1).map(([locLabel, g]) => (
                <form key={locLabel} action={mergeIntakes} className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-accent/40 bg-sky-50 p-3 text-sm">
                  {g.map((i) => <input key={i.id} type="hidden" name="intake_id" value={i.id} />)}
                  <span>Masz {g.length} paczki do wysłania na <b>{locLabel}</b> – możesz wysłać je razem.</span>
                  <button className="btn">Połącz w jedną paczkę</button>
                </form>
              ));
            })()}
            <IntakeList intakes={intakes} />
          </section>
        </>
      )}

      {tab === "sprzedane" && <>
      <section className="mb-6">
        <h2 className="h2 mb-2">Sprzedane</h2>
        <SoldList rows={soldRows} />
      </section>

      {bal.payouts.length > 0 && (
        <section>
          <h2 className="h2 mb-2">Wypłaty</h2>
          <div className="card overflow-x-auto">
            <table className="table mtable mtable-flow">
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

/** Historia rzeczy komisanta: wszystko, co działo się z jego rzeczami, od najnowszych. */
function History({ rows }: { rows: Awaited<ReturnType<typeof consignorTimeline>> }) {
  if (!rows.length) return <p className="text-sm text-muted">Jeszcze nic się nie wydarzyło.</p>;
  const byDay = new Map<string, typeof rows>();
  for (const r of rows) {
    const day = dateOnly(r.created_at);
    byDay.set(day, [...(byDay.get(day) ?? []), r]);
  }
  const dot = { green: "bg-emerald-500", blue: "bg-blue-500", amber: "bg-amber-500", slate: "bg-slate-400", red: "bg-red-500" };
  return (
    <div className="space-y-5">
      {[...byDay.entries()].map(([day, list]) => (
        <section key={day}>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">{day}</h3>
          <ol className="card divide-y divide-line">
            {list.map((r, i) => {
              const d = describeEvent(r, true);
              return (
                <li key={i} className="flex items-start gap-3 px-4 py-2.5 text-sm">
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot[d.tone]}`} />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{d.title}</span>{d.detail && <span className="text-muted"> · {d.detail}</span>}
                    {r.label && <span className="block text-xs text-muted">{r.label}{r.code ? ` · ${r.code}` : ""}</span>}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-muted">{new Date(r.created_at).toLocaleTimeString("pl-PL", { timeZone: "Europe/Warsaw", hour: "2-digit", minute: "2-digit" })}</span>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
