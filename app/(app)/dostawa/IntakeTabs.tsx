import Link from "next/link";
import { ReceiveChecklist } from "./ReceiveChecklist";
import { TransitNoDoc, type TransitUnit } from "./TransitNoDoc";
import { requireProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { dateOnly, dateTime, money } from "@/lib/labels";
import { Pill } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { VariantPick } from "@/components/VariantPick";
import { INTAKE_STATUS, PURCHASE_FORM_SHORT, type Intake, type IntakeItem } from "@/lib/intake";
import { acceptContract, rejectContract } from "../umowy/actions";
import { decideIntake, offerContract, receiveContractUnits, receiveIntake } from "./intake-actions";
import { ContractDecision, IntakeDecisionCells } from "./DecisionControls";
import { cancelTransfer, receiveTransfer } from "./transfer-actions";
import { ConfirmSubmit } from "@/components/ConfirmSubmit";

type Loc = { id: string; name: string; store_id: string; store: { name: string } | null };
type IntakeRow = Intake & { items: IntakeItem[]; consignor: { id: string; name: string } | null };
type ContractRow = {
  id: string; number: number | null; counterparty: string; seller_name: string | null; status: string; source: string | null; created_at: string; signed_at: string | null;
  items: { title: string; option: string; qty: number; price: number; unit_id?: string; variant_id?: string }[] | null; location_id: string | null; sale_id: string | null;
  currency: string | null; offer: { prices?: number[]; sent_at?: string } | null; sign_expires_at: string | null;
  type: string; doc_number: string | null; vat_form: string | null;
};

const BACK = "/dostawa?zakladka=akceptacja";

export async function loadIntakeCounts() {
  const db = createAdminClient();
  const [a, b, c, d, e] = await Promise.all([
    db.from("consignor_intakes").select("id", { count: "exact", head: true }).eq("status", "review"),
    db.from("contracts").select("id", { count: "exact", head: true }).eq("status", "signed").not("template", "is", null),
    db.from("consignor_intakes").select("id", { count: "exact", head: true }).in("status", ["to_send", "sent"]),
    db.from("units").select("contract_id", { count: "exact", head: true }).eq("status", "in_transit").not("contract_id", "is", null),
    db.from("stock_transfers").select("id", { count: "exact", head: true }).eq("status", "in_transit"),
  ]);
  return { accept: (a.count ?? 0) + (b.count ?? 0), transit: (c.count ?? 0) + (d.count ?? 0) + (e.error ? 0 : e.count ?? 0) };
}

/** Do akceptacji: zgłoszenia komisantów i podpisane umowy – Tak / Nie / Oferta. */
export async function AcceptTab() {
  const { supabase, profile } = await requireProfile();
  const db = createAdminClient();
  const [{ data: intakes }, { data: contracts }, { data: invoices }, { data: locations }] = await Promise.all([
    db.from("consignor_intakes").select("*, items:consignor_intake_items(*), consignor:consignors(id, name)").in("status", ["review", "offer"]).order("created_at"),
    supabase.from("contracts").select("id, number, counterparty, seller_name, status, source, created_at, signed_at, items, location_id, sale_id, currency, offer, sign_expires_at, type, doc_number, vat_form").in("status", ["signed", "offer"]).not("template", "is", null).order("signed_at"),
    supabase.from("contracts").select("id, doc_number, counterparty, amount, created_at").eq("status", "signed").eq("source", "consignor_invoice").order("created_at"),
    supabase.from("locations").select("id, name, store_id, store:stores(name)").eq("active", true).order("name"),
  ]);
  const locs = (locations ?? []) as unknown as Loc[];
  const locName = (id: string | null) => { const l = locs.find((x) => x.id === id); return l ? `${l.store?.name ?? ""} · ${l.name}` : "–"; };
  const all = (intakes ?? []) as unknown as IntakeRow[];
  const review = all.filter((i) => i.status === "review");
  const offerWait = all.filter((i) => i.status === "offer");
  const cs = (contracts ?? []) as unknown as ContractRow[];
  const signed = cs.filter((c) => c.status === "signed");
  const contractOffers = cs.filter((c) => c.status === "offer");
  const prices = profile.can_see_prices;

  return (
    <div className="space-y-6">
      {!review.length && !signed.length && !invoices?.length && <p className="text-sm text-muted">Nic nie czeka na decyzję.</p>}

      {review.map((i) => (
        <form key={i.id} action={decideIntake} className="card space-y-3 p-4">
          <input type="hidden" name="intake_id" value={i.id} />
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone="blue">komis</Pill>
            <b><Link className="text-accent hover:underline" href={`/komisanci/${i.consignor?.id}`}>{i.consignor?.name}</Link></b>
            <span className="text-sm text-muted">zgłoszenie z {dateTime(i.created_at)} · wyśle na {locName(i.location_id)}</span>
          </div>
          {i.note && <p className="rounded bg-panel p-2 text-sm">{i.note}</p>}
          <div className="overflow-x-auto">
            <table className="table mtable mtable-flow">
              <thead><tr><th>Rzecz</th><th>Rozmiar</th><th>Rozliczenie</th><th className="text-right">Kwota komisanta</th><th>Decyzja</th><th>Twoja kwota (oferta)</th></tr></thead>
              <tbody>
                {[...i.items].sort((a, b) => a.position - b.position).filter((x) => x.status === "proposed").map((x) => (
                  <tr key={x.id}>
                    <td>{x.title}{!x.variant_id && <span className="ml-1 text-xs text-warn">(spoza katalogu)</span>}</td>
                    <td className="font-medium">{x.option ?? "–"}</td>
                    <td className="whitespace-nowrap text-sm">{PURCHASE_FORM_SHORT[x.purchase_form] ?? "VAT marża"}</td>
                    <td className="text-right tabular-nums">{money(x.proposed_price)}</td>
                    <IntakeDecisionCells id={x.id} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-3">
            <SubmitButton pendingText="Zapisuję…">Zapisz decyzje i powiadom komisanta</SubmitButton>
            <span className="text-xs text-muted">Tak → komisant dostaje e-mail, że może wysłać. Oferta → e-mail z Twoją kwotą do akceptacji.</span>
          </div>
        </form>
      ))}

      {signed.map((c) => {
        const items = c.items ?? [];
        const needsLocation = !c.location_id && items.some((it) => !it.unit_id);
        const needsAssign = items.some((it) => !it.unit_id && !it.variant_id);
        return (
          <div key={c.id} className="card space-y-3 p-4">
            <div className="flex flex-wrap items-center gap-2">
              {c.type === "invoice" ? <Pill tone="blue">faktura</Pill> : <Pill tone="amber">umowa</Pill>}
              <b><Link className="text-accent hover:underline" href={`/umowy/${c.id}`}>{c.type === "invoice" ? `FV ${c.doc_number} (link umowy NR${c.number})` : `Umowa NR${c.number}`}</Link> · {c.seller_name ?? c.counterparty}</b>
              {c.type === "invoice" && <a className="text-sm text-accent hover:underline" href={`/api/umowy/${c.id}/pdf`} target="_blank" rel="noreferrer">zobacz fakturę{c.vat_form === "vat_23" ? " (VAT 23%)" : c.vat_form === "vat_margin" ? " (VAT marża)" : ""}</a>}
              <span className="text-sm text-muted">{c.type === "invoice" ? "przesłana" : "podpisana"} {dateTime(c.signed_at)}{c.source === "general" ? " · z ogólnego linku" : ""}{c.location_id ? ` · towar na ${locName(c.location_id)}` : ""}</span>
            </div>
            <ContractDecision
              id={c.id} back={BACK} showPrices={prices} needsLocation={needsLocation} currency={c.currency} allowOffer={c.type !== "invoice"}
              items={items.map((it) => ({ title: it.title, option: it.option, qty: Number(it.qty ?? 1), price: Number(it.price), unassigned: !it.unit_id && !it.variant_id }))}
              locations={locs.map((l) => ({ id: l.id, label: `${l.store?.name ?? ""} · ${l.name}` }))}
              accept={acceptContract} reject={rejectContract} offer={offerContract}
            />
            {needsAssign && <p className="text-xs text-warn">Po zatwierdzeniu przypisz pozycje do katalogu na stronie umowy – wtedy powstaną sztuki „w drodze”.</p>}
          </div>
        );
      })}

      {!!invoices?.length && (
        <section className="card p-4">
          <h2 className="h2 mb-2">Faktury komisantów do zatwierdzenia</h2>
          <ul className="space-y-1 text-sm">
            {invoices.map((f) => <li key={f.id}><Link className="text-accent hover:underline" href={`/umowy/${f.id}`}>Faktura {f.doc_number} · {f.counterparty}</Link>{prices && f.amount !== null ? ` · ${money(f.amount)}` : ""} <span className="text-muted">({dateOnly(f.created_at)})</span></li>)}
          </ul>
        </section>
      )}

      {(offerWait.length > 0 || contractOffers.length > 0) && (
        <section className="card p-4">
          <h2 className="h2 mb-2">Czekają na odpowiedź na Twoją ofertę</h2>
          <ul className="space-y-1 text-sm">
            {offerWait.map((i) => <li key={i.id}>Komis · {i.consignor?.name} · {i.items.filter((x) => x.status === "offered").length} szt. z ofertą <span className="text-muted">({INTAKE_STATUS[i.status].text})</span></li>)}
            {contractOffers.map((c) => <li key={c.id}><Link className="text-accent hover:underline" href={`/umowy/${c.id}`}>Umowa NR{c.number}</Link> · {c.seller_name ?? c.counterparty} <span className="text-muted">· oferta wysłana {dateTime(c.offer?.sent_at ?? null)}, ważna do {dateOnly(c.sign_expires_at)}</span></li>)}
          </ul>
        </section>
      )}
    </div>
  );
}

/** W drodze: paczki od komisantów (po akceptacji) i towar z umów – przyjęcie do magazynu. */
export async function TransitTab() {
  const { supabase, profile } = await requireProfile();
  const db = createAdminClient();
  const unitFields = "id, code, contract_id, received_at, variant:variants(option, product:products(id, title)), contract:contracts(id, number, counterparty, seller_name), location:locations(name, store_id)";
  const [{ data: intakes }, unitsRes, { data: locations }, transfersRes] = await Promise.all([
    db.from("consignor_intakes").select("*, items:consignor_intake_items(*), consignor:consignors(id, name)").in("status", ["to_send", "sent"]).order("sent_at", { nullsFirst: false }),
    // Rzeczy z przesunięć między magazynami mają osobną kartę (niżej).
    supabase.from("units").select(unitFields).eq("status", "in_transit").not("contract_id", "is", null).is("transfer_id", null).order("received_at").limit(500),
    supabase.from("locations").select("id, name, store_id, store:stores(name)").eq("active", true).order("name"),
    supabase.from("stock_transfers").select("id, number, note, created_at, from_location_id, to_location_id").eq("status", "in_transit").order("created_at"),
  ]);
  // Baza bez migracji 0035 (brak kolumny transfer_id) – lista jak wcześniej.
  const units = unitsRes.error
    ? (await supabase.from("units").select(unitFields).eq("status", "in_transit").not("contract_id", "is", null).order("received_at").limit(500)).data
    : unitsRes.data;
  // Rzeczy w drodze bez umowy / faktury (np. z Przyjęcia dostawy z opcją „w drodze”) – do „Umowa” / „Faktura” jednym kliknięciem.
  const noDocRes = await supabase.from("units").select("*, variant:variants(option, product:products(id, title)), location:locations(name, store_id)")
    .eq("status", "in_transit").is("contract_id", null).is("transfer_id", null).order("received_at").limit(300);
  const noDoc: TransitUnit[] = ((noDocRes.error ? [] : noDocRes.data ?? []) as unknown as { id: string; code: string; purchase_price: number | null; supplier?: string | null; variant: { option: string; product: { id: string; title: string } }; location: { name: string; store_id: string } | null }[])
    .map((u) => ({ id: u.id, code: u.code, title: u.variant.product.title, option: u.variant.option, location: u.location?.name ?? "–", price: profile.can_see_prices && u.purchase_price != null ? Number(u.purchase_price) : null, productId: u.variant.product.id, storeId: u.location?.store_id ?? null, supplier: u.supplier ?? null }));
  const transfers = (transfersRes.error ? [] : transfersRes.data ?? []) as { id: string; number: number; note: string | null; created_at: string; from_location_id: string; to_location_id: string }[];
  const { data: tItems } = transfers.length ? await supabase.from("stock_transfer_items").select("transfer_id, unit_id, received_at").in("transfer_id", transfers.map((t) => t.id)) : { data: [] };
  const tIds = (tItems ?? []).map((i) => i.unit_id as string);
  const { data: tUnits } = tIds.length ? await supabase.from("units_list").select("id, code, title, option, status, product_id, store_id").in("id", tIds) : { data: [] };
  const unitById = new Map((tUnits ?? []).map((u) => [u.id as string, u as { id: string; code: string; title: string; option: string; status: string; product_id: string; store_id: string }]));
  const locs = (locations ?? []) as unknown as Loc[];
  type TU = { id: string; code: string; contract_id: string; variant: { option: string; product: { id: string; title: string } }; contract: { id: string; number: number | null; counterparty: string; seller_name: string | null }; location: { name: string; store_id: string } | null };
  const byContract = new Map<string, TU[]>();
  for (const u of (units ?? []) as unknown as TU[]) byContract.set(u.contract_id, [...(byContract.get(u.contract_id) ?? []), u]);
  const list = (intakes ?? []) as unknown as IntakeRow[];
  const locName = (id: string) => { const l = locs.find((x) => x.id === id); return l ? `${l.store?.name ?? ""} · ${l.name}` : "–"; };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <Link className="btn" href="/dostawa?w_drodze=1">Dodaj rzeczy w drodze</Link>
        <span className="text-sm text-muted">Przyjęcie dostawy z zaznaczonym „w drodze” – potem tu: umowa albo faktura jednym kliknięciem.</span>
      </div>
      {!list.length && !byContract.size && !transfers.length && !noDoc.length && <p className="text-sm text-muted">Nic nie jest w drodze.</p>}
      {noDoc.length > 0 && <TransitNoDoc units={noDoc} prices={profile.can_see_prices} />}

      {transfers.map((t) => {
        const its = (tItems ?? []).filter((i) => i.transfer_id === t.id);
        const open = its.filter((i) => !i.received_at && unitById.get(i.unit_id as string)?.status === "in_transit");
        const done = its.length - open.length;
        return (
          <div key={t.id} className="card space-y-3 p-4">
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone="green">przesunięcie</Pill>
                <b>Nr {t.number}</b>
                <span className="text-sm">{locName(t.from_location_id)} <span className="text-muted">→</span> <b>{locName(t.to_location_id)}</b></span>
                <span className="text-sm text-muted">wysłane {dateTime(t.created_at)} · {open.length} szt. w drodze{done ? ` · ${done} już przyjęte` : ""}</span>
                <Link className="ml-auto text-sm text-accent hover:underline" href={`/druk/przesuniecie/${t.id}`} target="_blank">Lista (druk)</Link>
              </div>
              {t.note && <p className="rounded bg-panel p-2 text-sm">{t.note}</p>}
              <ReceiveChecklist action={receiveTransfer} hidden={{ transfer_id: t.id }}
                units={open.map((i) => unitById.get(i.unit_id as string)).filter((u): u is NonNullable<typeof u> => !!u).map((u) => ({ id: u.id, title: u.title, option: u.option, code: u.code, productId: u.product_id, storeId: u.store_id }))} />
            </div>
            <form action={cancelTransfer} className="border-t border-line pt-2">
              <input type="hidden" name="transfer_id" value={t.id} />
              <ConfirmSubmit className="text-xs text-muted hover:text-bad hover:underline" message={`Anulować przesunięcie nr ${t.number}? Rzeczy jeszcze w drodze wrócą na stan magazynu źródłowego.`}>Anuluj przesunięcie (rzeczy wracają do {locName(t.from_location_id)})</ConfirmSubmit>
            </form>
          </div>
        );
      })}
      {list.map((i) => {
        const items = [...i.items].sort((a, b) => a.position - b.position).filter((x) => x.status === "accepted");
        const loc = locs.find((l) => l.id === i.location_id);
        return (
          <form key={i.id} action={receiveIntake} className="card space-y-3 p-4">
            <input type="hidden" name="intake_id" value={i.id} />
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone="blue">komis</Pill>
              <b><Link className="text-accent hover:underline" href={`/komisanci/${i.consignor?.id}`}>{i.consignor?.name}</Link></b>
              <Pill tone={i.status === "sent" ? "blue" : "amber"}>{INTAKE_STATUS[i.status].text}</Pill>
              {i.tracking && <span className="font-mono text-sm">{i.carrier ? `${i.carrier} · ` : ""}{i.tracking}</span>}
            </div>
            <div className="overflow-x-auto">
              <table className="table mtable mtable-flow">
                <thead><tr><th>Dotarło</th><th>Rzecz</th><th>Rozmiar</th><th>Rozliczenie</th>{profile.can_see_prices && <th className="text-right">Kwota komisanta</th>}<th>Produkt z katalogu</th></tr></thead>
                <tbody>
                  {items.map((x) => (
                    <tr key={x.id}>
                      <td><input type="checkbox" name={`got_${x.id}`} defaultChecked className="h-4 w-4" aria-label="Dotarło" /></td>
                      <td>{x.title}</td>
                      <td className="font-medium">{x.option ?? "–"}</td>
                      <td className="whitespace-nowrap text-sm">{PURCHASE_FORM_SHORT[x.purchase_form] ?? "VAT marża"}</td>
                      {profile.can_see_prices && <td className="text-right tabular-nums">{money(x.final_price)}</td>}
                      <td className="min-w-64">{x.variant_id ? <span className="text-sm text-ok">z katalogu ✓</span> : <VariantPick name={`v_${x.id}`} storeId={loc?.store_id ?? ""} label="Produkt z katalogu (puste = nieprzypisany do Shopify)" />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <select className="input w-64" name="location_id" defaultValue={i.location_id} aria-label="Lokalizacja">
                {locs.map((l) => <option key={l.id} value={l.id}>{l.store?.name} · {l.name}</option>)}
              </select>
              <SubmitButton pendingText="Przyjmuję…">Przyjmij do magazynu</SubmitButton>
              <span className="text-xs text-muted">Rzeczy trafią na stan jako komis tego komisanta z jego kwotą; po zapisie wydrukujesz etykiety.</span>
            </div>
          </form>
        );
      })}

      {[...byContract.entries()].map(([cid, us]) => (
        <div key={cid} className="card space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone="amber">umowa</Pill>
            <b><Link className="text-accent hover:underline" href={`/umowy/${cid}`}>Umowa NR{us[0].contract.number}</Link> · {us[0].contract.seller_name ?? us[0].contract.counterparty}</b>
            <span className="text-sm text-muted">{us.length} szt. w drodze{us[0].location ? ` · do ${us[0].location.name}` : ""}</span>
          </div>
          <ReceiveChecklist action={receiveContractUnits} hidden={{ contract_id: cid }} noUnitOption
            units={us.map((u) => ({ id: u.id, title: u.variant.product.title, option: u.variant.option, code: u.code, productId: u.variant.product.id, storeId: u.location?.store_id }))} />
        </div>
      ))}
    </div>
  );
}
