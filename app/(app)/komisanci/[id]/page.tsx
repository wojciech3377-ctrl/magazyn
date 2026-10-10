import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { dateOnly, dateTime, money, UNIT_STATUS } from "@/lib/labels";
import { Notice, PageHeader, Pill } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { createAdminClient } from "@/lib/supabase/admin";
import { consignorBalance, consignorUnits, SHIPMENT_METHOD, SHIPMENT_STATUS, type Consignor, type ConsignorShipment } from "@/lib/consignment";
import { addPayout, createConsignorAccount, deletePayout, openLabel, processShipment, removeConsignorAccount, resetConsignorPassword, saveConsignor } from "../actions";

export default async function ConsignorPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const { supabase, profile } = await requireProfile();
  const { data: c } = await supabase.from("consignors").select("*").eq("id", id).maybeSingle();
  if (!c) notFound();
  const consignor = c as Consignor;
  const db = createAdminClient();
  const units = await consignorUnits(db, id);
  const bal = await consignorBalance(db, id, units);
  const { data: shipments } = await supabase.from("consignor_shipments").select("*").eq("consignor_id", id).order("created_at", { ascending: false }).limit(50);
  const nameOf = new Map(units.map((u) => [u.id, `${u.title} ${u.option} (${u.code})`]));
  const prices = profile.can_see_prices;
  const isAdmin = profile.role === "admin";

  return (
    <>
      <PageHeader title={consignor.name} sub="Komisant" actions={<><Link className="btn-secondary" href={`/magazyn?wlasciciel=consignment&komisant=${id}&status=wszystkie`}>W Magazynie</Link><Link className="btn-secondary" href="/komisanci">Wróć</Link></>} />
      {sp.ok && <div className="mb-4"><Notice tone="ok">{sp.ok}</Notice></div>}
      {sp.blad && <div className="mb-4"><Notice tone="error">{sp.blad}</Notice></div>}

      <div className="mb-5 grid gap-3 sm:grid-cols-4">
        {[
          ["Na stanie", String(units.filter((u) => ["in_stock", "in_transit", "reserved", "consignor_hold"].includes(u.status)).length)],
          ["Sprzedane z dokumentem", money(bal.earned)],
          ["Wypłacone", money(bal.paid)],
          ["Do wypłaty", money(bal.balance)],
        ].map(([label, value], i) => (
          <div key={label} className={`card p-4 ${i === 3 ? "border-emerald-300 bg-emerald-50" : ""}`}>
            <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{prices || i === 0 ? value : "–"}</div>
          </div>
        ))}
      </div>

      <section className="card mb-5 overflow-x-auto">
        <h2 className="h2 p-4 pb-0">Zlecenia wysyłki do komisanta</h2>
        <table className="table">
          <thead><tr><th>Data</th><th>Rzeczy</th><th>Sposób / adres</th><th>Status</th><th /></tr></thead>
          <tbody>
            {!shipments?.length && <tr><td colSpan={5} className="py-6 text-center text-muted">Brak zleceń.</td></tr>}
            {((shipments ?? []) as ConsignorShipment[]).map((s) => (
              <tr key={s.id}>
                <td className="whitespace-nowrap text-sm text-muted">{dateTime(s.created_at)}</td>
                <td className="text-sm">{s.unit_ids.map((u) => nameOf.get(u) ?? "?").join(", ")}{s.note && <span className="block text-xs text-muted">Uwagi: {s.note}</span>}</td>
                <td className="text-sm">
                  {SHIPMENT_METHOD[s.method]}{s.shipping_fee ? ` · ${money(s.shipping_fee)}` : ""}
                  {s.address && <span className="block text-xs text-muted">{s.address.name}, {s.address.street}, {s.address.postcode} {s.address.city}{s.address.country !== "PL" ? `, ${s.address.country}` : ""} · {s.address.phone}</span>}
                  {s.label_path && <form action={openLabel} className="mt-1"><input type="hidden" name="id" value={id} /><input type="hidden" name="shipment_id" value={s.id} /><button className="text-xs text-accent hover:underline">Pobierz etykietę ({s.label_name ?? "plik"})</button></form>}
                  {s.method === "custom" && (s.invoice_id
                    ? <Link className="mt-1 block text-xs text-accent hover:underline" href={`/sprzedaz/faktury/${s.invoice_id}`}>Faktura za wysyłkę</Link>
                    : <Link className="mt-1 block text-xs text-warn hover:underline" href={`/sprzedaz/faktury/nowa?komis_wysylka=${s.id}`}>Wystaw fakturę za wysyłkę</Link>)}
                </td>
                <td><Pill tone={s.status === "shipped" ? "green" : s.status === "cancelled" ? "slate" : "amber"}>{SHIPMENT_STATUS[s.status]}</Pill>{s.tracking && <span className="block font-mono text-xs">{s.tracking}</span>}</td>
                <td>
                  {s.status === "requested" && (
                    <div className="flex flex-col gap-1.5">
                      <form action={processShipment} className="flex gap-1">
                        <input type="hidden" name="id" value={id} /><input type="hidden" name="shipment_id" value={s.id} /><input type="hidden" name="op" value="shipped" />
                        <input className="input w-40 py-1 text-xs" name="tracking" placeholder="numer przesyłki" aria-label="Numer przesyłki" />
                        <SubmitButton className="btn px-2.5 py-1 text-xs" pendingText="…">Wysłane</SubmitButton>
                      </form>
                      <form action={processShipment}>
                        <input type="hidden" name="id" value={id} /><input type="hidden" name="shipment_id" value={s.id} /><input type="hidden" name="op" value="cancel" />
                        <SubmitButton className="text-xs text-bad hover:underline" pendingText="…">Anuluj (rzeczy wracają na stan)</SubmitButton>
                      </form>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="grid gap-5 lg:grid-cols-3">
        <section className="card min-w-0 overflow-x-auto lg:col-span-2">
          <h2 className="h2 p-4 pb-0">Rzeczy w komisie</h2>
          <table className="table">
            <thead><tr><th>Rzecz</th><th>Status</th><th>Data</th>{prices && <th className="text-right">Kwota komisanta</th>}<th>Rozliczenie</th></tr></thead>
            <tbody>
              {!units.length && <tr><td colSpan={5} className="py-6 text-center text-muted">Brak rzeczy.</td></tr>}
              {units.map((u) => (
                <tr key={u.id}>
                  <td><Link className="text-accent hover:underline" href={`/magazyn/${u.id}`}>{u.title} · <b>{u.option}</b></Link> <span className="font-mono text-xs text-muted">{u.code}</span></td>
                  <td className="text-sm">{UNIT_STATUS[u.status] ?? u.status}</td>
                  <td className="text-sm text-muted">{dateOnly(u.sold_at ?? u.received_at)}</td>
                  {prices && <td className="text-right tabular-nums">{money(u.payout_amount)}</td>}
                  <td>{["sold", "shipped"].includes(u.status) ? (u.has_document ? <Pill tone="green">do wypłaty</Pill> : <Pill tone="amber">bez paragonu / faktury</Pill>) : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <div className="space-y-5">
          {prices && (
            <section className="card space-y-3 p-4">
              <h2 className="h2">Wypłaty</h2>
              {isAdmin && (
                <form action={addPayout} className="grid grid-cols-2 gap-2">
                  <input type="hidden" name="id" value={id} />
                  <input className="input" name="amount" inputMode="decimal" placeholder="kwota" defaultValue={bal.balance > 0 ? bal.balance.toFixed(2) : ""} aria-label="Kwota wypłaty" />
                  <input className="input" type="date" name="paid_at" defaultValue={new Date().toISOString().slice(0, 10)} aria-label="Data przelewu" />
                  <input className="input col-span-2" name="note" placeholder="opis, np. przelew za 2 pary" aria-label="Opis" />
                  <SubmitButton className="btn col-span-2">Zapisz wypłatę (przelew)</SubmitButton>
                </form>
              )}
              <ul className="divide-y divide-line text-sm">
                {!bal.payouts.length && <li className="py-2 text-muted">Brak wypłat.</li>}
                {bal.payouts.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2 py-2">
                    <span>{dateOnly(p.paid_at)}{p.note && <span className="block text-xs text-muted">{p.note}</span>}</span>
                    <span className="flex items-center gap-2 tabular-nums">{money(p.amount)}
                      {isAdmin && <form action={deletePayout}><input type="hidden" name="id" value={id} /><input type="hidden" name="payout_id" value={p.id} /><button className="text-xs text-muted hover:text-bad" aria-label="Usuń wypłatę">×</button></form>}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <form action={saveConsignor} className="card space-y-2 p-4">
            <h2 className="h2">Dane i adres do wysyłki</h2>
            <input type="hidden" name="id" value={id} />
            <input className="input" name="name" defaultValue={consignor.name} required aria-label="Nazwa" />
            <input className="input" type="email" name="email" defaultValue={consignor.email ?? ""} placeholder="e-mail" aria-label="E-mail" />
            <input className="input" name="phone" defaultValue={consignor.phone ?? ""} placeholder="telefon" aria-label="Telefon" />
            <input className="input" name="bank_account" defaultValue={consignor.bank_account ?? ""} placeholder="konto do wypłat" aria-label="Konto do wypłat" />
            <input className="input" name="notes" defaultValue={consignor.notes ?? ""} placeholder="notatki" aria-label="Notatki" />
            <div className="pt-2 text-xs font-medium uppercase tracking-wide text-muted">Domyślny adres wysyłki zwrotów</div>
            <input className="input" name="address_name" defaultValue={consignor.address_name ?? ""} placeholder="odbiorca (puste = nazwa)" aria-label="Odbiorca" />
            <input className="input" name="address_street" defaultValue={consignor.address_street ?? ""} placeholder="ulica i numer" aria-label="Ulica" />
            <div className="grid grid-cols-[7rem_1fr_4rem] gap-2">
              <input className="input" name="address_postcode" defaultValue={consignor.address_postcode ?? ""} placeholder="kod" aria-label="Kod pocztowy" />
              <input className="input" name="address_city" defaultValue={consignor.address_city ?? ""} placeholder="miasto" aria-label="Miasto" />
              <input className="input uppercase" name="address_country" defaultValue={consignor.address_country ?? "PL"} maxLength={2} aria-label="Kraj" />
            </div>
            <input className="input" name="address_phone" defaultValue={consignor.address_phone ?? ""} placeholder="telefon do kuriera" aria-label="Telefon do kuriera" />
            <SubmitButton>Zapisz</SubmitButton>
          </form>

          {isAdmin && (
            <section className="card space-y-2 p-4">
              <h2 className="h2">Konto w panelu komisanta</h2>
              {consignor.user_id ? (
                <>
                  <p className="text-sm">Konto aktywne{consignor.email ? `: ${consignor.email}` : ""}. Komisant loguje się na stronie aplikacji i widzi tylko swoje rzeczy.</p>
                  <form action={resetConsignorPassword} className="flex gap-2">
                    <input type="hidden" name="id" value={id} />
                    <input className="input" type="text" name="password" placeholder="nowe hasło (min. 10 znaków)" autoComplete="off" aria-label="Nowe hasło" />
                    <SubmitButton className="btn-secondary whitespace-nowrap">Zmień hasło</SubmitButton>
                  </form>
                  <form action={removeConsignorAccount}>
                    <input type="hidden" name="id" value={id} />
                    <SubmitButton className="text-sm text-bad hover:underline" pendingText="…">Zablokuj dostęp (usuń konto)</SubmitButton>
                  </form>
                </>
              ) : (
                <form action={createConsignorAccount} className="space-y-2">
                  <input type="hidden" name="id" value={id} />
                  <input className="input" type="email" name="email" defaultValue={consignor.email ?? ""} placeholder="e-mail do logowania" aria-label="E-mail do logowania" required />
                  <input className="input" type="text" name="password" placeholder="hasło startowe (min. 10 znaków)" autoComplete="off" aria-label="Hasło startowe" required />
                  <SubmitButton>Utwórz konto komisanta</SubmitButton>
                </form>
              )}
            </section>
          )}
        </div>
      </div>
    </>
  );
}
