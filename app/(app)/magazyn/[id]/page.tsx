import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { UNIT_SELECT, type UnitRow } from "@/lib/queries/units";
import { CONTRACT_TYPE, dateOnly, dateTime, EVENT_TYPE, money, PURCHASE_FORM, SALE_STATUS, UNIT_STATUS } from "@/lib/labels";
import { Field, Notice, PageHeader, Pill, StatusBadge, Thumb } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { changeStatus, deleteUnit, updateUnit } from "../actions";

const NEXT_STATUS: Record<string, { to: string; label: string; danger?: boolean }[]> = {
  in_transit: [{ to: "in_stock", label: "Przyjmij na stan" }],
  in_stock: [
    { to: "reserved", label: "Zarezerwuj" },
    { to: "shipped", label: "Wydaj poza sklepem (−1 w Base)" },
    { to: "in_transit", label: "Cofnij do „w drodze”" },
  ],
  reserved: [{ to: "in_stock", label: "Zdejmij rezerwację" }, { to: "shipped", label: "Wydaj" }],
  sold: [{ to: "shipped", label: "Oznacz jako wysłaną" }, { to: "return_to_stock", label: "Zwrot – wraca na stan" }, { to: "returned", label: "Zwrot – do sprawdzenia" }],
  shipped: [{ to: "return_to_stock", label: "Zwrot – wraca na stan" }, { to: "returned", label: "Zwrot – do sprawdzenia" }],
  returned: [{ to: "in_stock", label: "Przywróć na stan" }],
};

export default async function UnitPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const { supabase, profile } = await requireProfile();

  const { data } = await supabase.from("units").select(UNIT_SELECT).eq("id", id).maybeSingle();
  if (!data) notFound();
  const u = data as unknown as UnitRow;

  const [{ data: events }, { data: sales }, { data: contracts }, { data: consignors }, { data: contract }] = await Promise.all([
    supabase.from("unit_events").select("id, type, data, created_at").eq("unit_id", id).order("created_at", { ascending: false }),
    supabase.from("sales").select("id, order_ref, status, sold_at, product_name").eq("unit_id", id).order("sold_at", { ascending: false }),
    supabase.from("contracts").select("id, counterparty, contract_date").order("created_at", { ascending: false }).limit(200),
    supabase.from("consignors").select("id, name").order("name"),
    u.contract_id ? supabase.from("contracts").select("*").eq("id", u.contract_id).single() : Promise.resolve({ data: null }),
  ]);

  let fileUrl: string | null = null;
  if (contract?.file_path) {
    const { data: signed } = await supabase.storage.from("contracts").createSignedUrl(contract.file_path, 600);
    fileUrl = signed?.signedUrl ?? null;
  }

  return (
    <>
      <PageHeader
        title={`${u.variant.product.title} · ${u.variant.option}`}
        sub={<span className="font-mono">{u.code}{u.identifier ? ` · ${u.identifier}` : ""}</span>}
        actions={
          <>
            <Link className="btn-secondary" href={`/etykiety?ids=${u.id}`} target="_blank">Drukuj etykietę</Link>
            <Link className="btn-secondary" href="/magazyn">Wróć do listy</Link>
          </>
        }
      />
      {sp.ok && <div className="mb-4"><Notice tone="ok">{sp.ok}</Notice></div>}
      {sp.blad && <div className="mb-4"><Notice tone="error">{sp.blad}</Notice></div>}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="min-w-0 space-y-5 lg:col-span-2">
          <section className="card p-4">
            <div className="mb-4 flex items-center gap-3">
              <Thumb src={u.variant.product.image_url} alt="" />
              <div className="text-sm">
                <div>SKU modelu: <b>{u.variant.product.style_sku ?? "–"}</b></div>
                <div className="text-muted">{u.location.store.name} · {u.location.name}</div>
              </div>
              <div className="ml-auto"><StatusBadge status={u.status} /></div>
            </div>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <Field label="Przyjęta">{dateTime(u.received_at)}</Field>
              <Field label="Sprzedana">{dateTime(u.sold_at)}</Field>
              <Field label="Forma sprzedaży">{PURCHASE_FORM[u.purchase_form]}</Field>
              <Field label="Właściciel">{u.owner_type === "consignment" ? `komis · ${u.consignor?.name}` : "własna"}</Field>
              {profile.can_see_prices && <Field label="Cena zakupu">{money(u.purchase_price)}</Field>}
              {profile.can_see_prices && u.owner_type === "consignment" && <Field label="Wypłata dla komisanta">{money(u.payout_amount)}</Field>}
            </div>
          </section>

          <section className="card p-4">
            <h2 className="h2 mb-3">Edycja</h2>
            <form action={updateUnit} className="grid gap-3 md:grid-cols-2">
              <input type="hidden" name="id" value={u.id} />
              <div>
                <label className="label" htmlFor="identifier">IMEI / numer seryjny</label>
                <input className="input" id="identifier" name="identifier" defaultValue={u.identifier ?? ""} />
              </div>
              <div>
                <label className="label" htmlFor="shelf">Regał / półka</label>
                <input className="input" id="shelf" name="shelf" defaultValue={u.shelf ?? ""} />
              </div>
              <div>
                <label className="label" htmlFor="owner_type">Właściciel</label>
                <select className="input" id="owner_type" name="owner_type" defaultValue={u.owner_type}>
                  <option value="own">własna</option>
                  <option value="consignment">komis</option>
                </select>
              </div>
              <div>
                <label className="label" htmlFor="consignor_id">Komisant (dla komisu)</label>
                <select className="input" id="consignor_id" name="consignor_id" defaultValue={u.consignor?.id ?? ""}>
                  <option value="">–</option>
                  {consignors?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="purchase_form">Forma sprzedaży</label>
                <select className="input" id="purchase_form" name="purchase_form" defaultValue={u.purchase_form}>
                  <option value="vat_margin">VAT marża</option>
                  <option value="vat_23">23% VAT</option>
                </select>
              </div>
              <div>
                <label className="label" htmlFor="contract_id">Umowa</label>
                <select className="input" id="contract_id" name="contract_id" defaultValue={u.contract_id ?? ""}>
                  <option value="">brak umowy</option>
                  {contracts?.map((c) => <option key={c.id} value={c.id}>{c.counterparty}{c.contract_date ? ` · ${dateOnly(c.contract_date)}` : ""}</option>)}
                </select>
              </div>
              {profile.can_see_prices && (
                <>
                  <div>
                    <label className="label" htmlFor="purchase_price">Cena zakupu (zł)</label>
                    <input className="input" id="purchase_price" name="purchase_price" inputMode="decimal" defaultValue={u.purchase_price ?? ""} />
                  </div>
                  <div>
                    <label className="label" htmlFor="payout_amount">Wypłata dla komisanta (zł)</label>
                    <input className="input" id="payout_amount" name="payout_amount" inputMode="decimal" defaultValue={u.payout_amount ?? ""} />
                  </div>
                </>
              )}
              <div className="md:col-span-2">
                <label className="label" htmlFor="notes">Notatki</label>
                <textarea className="input" id="notes" name="notes" rows={2} defaultValue={u.notes ?? ""} />
              </div>
              <div className="md:col-span-2"><SubmitButton>Zapisz zmiany</SubmitButton></div>
            </form>
          </section>

          <section className="card p-4">
            <h2 className="h2 mb-3">Historia</h2>
            <ol className="space-y-2 text-sm">
              {events?.map((e) => (
                <li key={e.id} className="flex gap-3">
                  <span className="w-32 shrink-0 text-muted">{dateTime(e.created_at)}</span>
                  <span>
                    <b>{EVENT_TYPE[e.type] ?? e.type}</b>
                    <EventDetails data={e.data as Record<string, unknown>} />
                  </span>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <div className="min-w-0 space-y-5">
          <section className="card p-4">
            <h2 className="h2 mb-3">Umowa</h2>
            {contract ? (
              <div className="space-y-2 text-sm">
                <div><Link className="font-medium text-accent hover:underline" href={`/umowy/${contract.id}`}>{contract.counterparty}</Link></div>
                <div className="text-muted">{CONTRACT_TYPE[contract.type]} · {dateOnly(contract.contract_date)}</div>
                {fileUrl ? <a className="btn-secondary w-full" href={fileUrl} target="_blank" rel="noreferrer">Otwórz plik umowy</a> : <Pill tone="amber">bez pliku</Pill>}
              </div>
            ) : (
              <div className="space-y-3 text-sm">
                <Pill tone="red">brak umowy</Pill>
                <p className="text-muted">Wybierz umowę w edycji albo <Link className="text-accent underline" href={`/umowy/nowa?sztuki=${u.code}`}>dodaj nową umowę dla tej sztuki</Link>.</p>
              </div>
            )}
          </section>

          <section className="card p-4">
            <h2 className="h2 mb-3">Status</h2>
            <div className="flex flex-col gap-2">
              {(NEXT_STATUS[u.status] ?? []).map((s) => (
                <form key={s.to} action={changeStatus}>
                  <input type="hidden" name="id" value={u.id} />
                  <input type="hidden" name="to" value={s.to} />
                  <SubmitButton className="btn-secondary w-full" pendingText="Zmieniam…">{s.label}</SubmitButton>
                </form>
              ))}
            </div>
          </section>

          {sales && sales.length > 0 && (
            <section className="card p-4">
              <h2 className="h2 mb-3">Sprzedaż</h2>
              <ul className="space-y-2 text-sm">
                {sales.map((s) => (
                  <li key={s.id}>
                    <b>{s.order_ref}</b> · {dateTime(s.sold_at)}
                    <span className="block text-muted">{SALE_STATUS[s.status]}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {profile.role === "admin" && (
            <form action={deleteUnit} className="text-right">
              <input type="hidden" name="id" value={u.id} />
              <SubmitButton className="btn-danger" pendingText="Usuwam…">Usuń sztukę (pomyłka)</SubmitButton>
            </form>
          )}
        </div>
      </div>
    </>
  );
}

function EventDetails({ data }: { data: Record<string, unknown> }) {
  const parts: string[] = [];
  if (typeof data.order === "string") parts.push(`zamówienie ${data.order}`);
  if (typeof data.from === "string" && typeof data.to === "string" && (UNIT_STATUS[data.from] || UNIT_STATUS[data.to])) {
    parts.push(`${UNIT_STATUS[data.from] ?? data.from} → ${UNIT_STATUS[data.to] ?? data.to}`);
  }
  if (typeof data.replaced_by === "string") parts.push(`zastąpiona sztuką ${data.replaced_by}`);
  if (data.swapped) parts.push("wybrana skanem przy pakowaniu");
  if (typeof data.source === "string") parts.push(data.source);
  if (data.back_to_stock !== undefined) parts.push(data.back_to_stock ? "wraca na stan" : "do sprawdzenia");
  return parts.length ? <span className="text-muted"> · {parts.join(" · ")}</span> : null;
}
