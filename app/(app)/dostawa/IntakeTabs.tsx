import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { dateOnly, dateTime, money } from "@/lib/labels";
import { Pill } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { VariantPick } from "@/components/VariantPick";
import { INTAKE_STATUS, type Intake, type IntakeItem } from "@/lib/intake";
import { acceptContract, rejectContract } from "../umowy/actions";
import { decideIntake, offerContract, receiveContractUnits, receiveIntake } from "./intake-actions";

type Loc = { id: string; name: string; store_id: string; store: { name: string } | null };
type IntakeRow = Intake & { items: IntakeItem[]; consignor: { id: string; name: string } | null };
type ContractRow = {
  id: string; number: number | null; counterparty: string; seller_name: string | null; status: string; source: string | null; created_at: string; signed_at: string | null;
  items: { title: string; option: string; qty: number; price: number; unit_id?: string; variant_id?: string }[] | null; location_id: string | null; sale_id: string | null;
  currency: string | null; offer: { prices?: number[]; sent_at?: string } | null; sign_expires_at: string | null;
};

const BACK = "/dostawa?zakladka=akceptacja";

export async function loadIntakeCounts() {
  const db = createAdminClient();
  const [a, b, c, d] = await Promise.all([
    db.from("consignor_intakes").select("id", { count: "exact", head: true }).eq("status", "review"),
    db.from("contracts").select("id", { count: "exact", head: true }).eq("status", "signed").not("template", "is", null),
    db.from("consignor_intakes").select("id", { count: "exact", head: true }).in("status", ["to_send", "sent"]),
    db.from("units").select("contract_id", { count: "exact", head: true }).eq("status", "in_transit").not("contract_id", "is", null),
  ]);
  return { accept: (a.count ?? 0) + (b.count ?? 0), transit: (c.count ?? 0) + (d.count ?? 0) };
}

/** Do akceptacji: zgłoszenia komisantów i podpisane umowy – Tak / Nie / Oferta. */
export async function AcceptTab() {
  const { supabase, profile } = await requireProfile();
  const db = createAdminClient();
  const [{ data: intakes }, { data: contracts }, { data: invoices }, { data: locations }] = await Promise.all([
    db.from("consignor_intakes").select("*, items:consignor_intake_items(*), consignor:consignors(id, name)").in("status", ["review", "offer"]).order("created_at"),
    supabase.from("contracts").select("id, number, counterparty, seller_name, status, source, created_at, signed_at, items, location_id, sale_id, currency, offer, sign_expires_at").in("status", ["signed", "offer"]).not("template", "is", null).order("signed_at"),
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
            <table className="table">
              <thead><tr><th>Rzecz</th><th>Rozmiar</th><th className="text-right">Kwota komisanta</th><th>Decyzja</th><th>Twoja kwota (oferta)</th></tr></thead>
              <tbody>
                {[...i.items].sort((a, b) => a.position - b.position).filter((x) => x.status === "proposed").map((x) => (
                  <tr key={x.id}>
                    <td>{x.title}{!x.variant_id && <span className="ml-1 text-xs text-warn">(spoza katalogu)</span>}</td>
                    <td className="font-medium">{x.option ?? "–"}</td>
                    <td className="text-right tabular-nums">{money(x.proposed_price)}</td>
                    <td className="whitespace-nowrap text-sm">
                      <label className="mr-3 inline-flex items-center gap-1 text-ok"><input type="radio" name={`d_${x.id}`} value="yes" required /> Tak</label>
                      <label className="mr-3 inline-flex items-center gap-1 text-bad"><input type="radio" name={`d_${x.id}`} value="no" /> Nie</label>
                      <label className="inline-flex items-center gap-1 text-accent"><input type="radio" name={`d_${x.id}`} value="offer" /> Oferta</label>
                    </td>
                    <td className="w-36"><input className="input" name={`o_${x.id}`} inputMode="decimal" placeholder="kwota przy Ofercie" aria-label="Kwota oferty" /></td>
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
        const needsLocation = !c.location_id && items.some((it) => !it.unit_id && it.variant_id);
        const needsAssign = items.some((it) => !it.unit_id && !it.variant_id);
        const locSelect = needsLocation ? (
          <select className="input w-56" name="location_id" aria-label="Dokąd przyjdzie towar">
            {locs.map((l) => <option key={l.id} value={l.id}>{l.store?.name} · {l.name}</option>)}
          </select>
        ) : null;
        return (
          <div key={c.id} className="card space-y-3 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone="amber">umowa</Pill>
              <b><Link className="text-accent hover:underline" href={`/umowy/${c.id}`}>Umowa nr {c.number}</Link> · {c.seller_name ?? c.counterparty}</b>
              <span className="text-sm text-muted">podpisana {dateTime(c.signed_at)}{c.source === "general" ? " · z ogólnego linku" : ""}{c.location_id ? ` · towar na ${locName(c.location_id)}` : ""}</span>
            </div>
            <form action={offerContract} id={`oferta-${c.id}`}>
              <input type="hidden" name="id" value={c.id} />
              <div className="overflow-x-auto">
                <table className="table">
                  <thead><tr><th>Pozycja</th><th>Rozmiar</th><th className="text-right">Ilość</th>{prices && <th className="text-right">Cena sprzedającego</th>}<th>Twoja oferta</th></tr></thead>
                  <tbody>
                    {items.map((it, idx) => (
                      <tr key={idx}>
                        <td>{it.title}{!it.unit_id && !it.variant_id && <span className="ml-1 text-xs text-warn">(do przypisania do katalogu)</span>}</td>
                        <td className="font-medium">{it.option}</td>
                        <td className="text-right">{it.qty ?? 1}</td>
                        {prices && <td className="text-right tabular-nums">{money(it.price)}</td>}
                        <td className="w-36"><input className="input" name={`p_${idx}`} inputMode="decimal" placeholder={prices ? String(it.price) : ""} aria-label="Nowa cena" /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </form>
            <div className="flex flex-wrap items-end gap-2">
              <form action={acceptContract} className="flex items-end gap-2">
                <input type="hidden" name="id" value={c.id} />
                <input type="hidden" name="back" value={BACK} />
                {locSelect}
                <SubmitButton className="btn" pendingText="…">Tak – zatwierdź</SubmitButton>
              </form>
              <form action={rejectContract}>
                <input type="hidden" name="id" value={c.id} />
                <input type="hidden" name="back" value={BACK} />
                <SubmitButton className="btn-danger" pendingText="…">Nie – odrzuć</SubmitButton>
              </form>
              <span className="flex items-end gap-2">
                {needsLocation && (
                  <select className="input w-56" name="location_id" form={`oferta-${c.id}`} aria-label="Dokąd przyjdzie towar (oferta)">
                    {locs.map((l) => <option key={l.id} value={l.id}>{l.store?.name} · {l.name}</option>)}
                  </select>
                )}
                <input className="input w-64" name="note" form={`oferta-${c.id}`} placeholder="Wiadomość do sprzedającego (opcjonalnie)" maxLength={500} />
                <button className="btn-secondary border-accent text-accent" form={`oferta-${c.id}`}>Oferta – wyślij nowe ceny</button>
              </span>
            </div>
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
            {contractOffers.map((c) => <li key={c.id}><Link className="text-accent hover:underline" href={`/umowy/${c.id}`}>Umowa nr {c.number}</Link> · {c.seller_name ?? c.counterparty} <span className="text-muted">· oferta wysłana {dateTime(c.offer?.sent_at ?? null)}, ważna do {dateOnly(c.sign_expires_at)}</span></li>)}
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
  const [{ data: intakes }, { data: units }, { data: locations }] = await Promise.all([
    db.from("consignor_intakes").select("*, items:consignor_intake_items(*), consignor:consignors(id, name)").in("status", ["to_send", "sent"]).order("sent_at", { nullsFirst: false }),
    supabase.from("units").select("id, code, contract_id, received_at, variant:variants(option, product:products(title)), contract:contracts(id, number, counterparty, seller_name), location:locations(name)").eq("status", "in_transit").not("contract_id", "is", null).order("received_at").limit(500),
    supabase.from("locations").select("id, name, store_id, store:stores(name)").eq("active", true).order("name"),
  ]);
  const locs = (locations ?? []) as unknown as Loc[];
  type TU = { id: string; code: string; contract_id: string; variant: { option: string; product: { title: string } }; contract: { id: string; number: number | null; counterparty: string; seller_name: string | null }; location: { name: string } | null };
  const byContract = new Map<string, TU[]>();
  for (const u of (units ?? []) as unknown as TU[]) byContract.set(u.contract_id, [...(byContract.get(u.contract_id) ?? []), u]);
  const list = (intakes ?? []) as unknown as IntakeRow[];

  return (
    <div className="space-y-6">
      {!list.length && !byContract.size && <p className="text-sm text-muted">Nic nie jest w drodze.</p>}
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
              <table className="table">
                <thead><tr><th>Dotarło</th><th>Rzecz</th><th>Rozmiar</th>{profile.can_see_prices && <th className="text-right">Kwota komisanta</th>}<th>Produkt z katalogu</th></tr></thead>
                <tbody>
                  {items.map((x) => (
                    <tr key={x.id}>
                      <td><input type="checkbox" name={`got_${x.id}`} defaultChecked className="h-4 w-4" aria-label="Dotarło" /></td>
                      <td>{x.title}</td>
                      <td className="font-medium">{x.option ?? "–"}</td>
                      {profile.can_see_prices && <td className="text-right tabular-nums">{money(x.final_price)}</td>}
                      <td className="min-w-64">{x.variant_id ? <span className="text-sm text-ok">z katalogu ✓</span> : <VariantPick name={`v_${x.id}`} storeId={loc?.store_id ?? ""} label="Wybierz produkt i rozmiar" />}</td>
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
        <form key={cid} action={receiveContractUnits} className="card space-y-3 p-4">
          <input type="hidden" name="contract_id" value={cid} />
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone="amber">umowa</Pill>
            <b><Link className="text-accent hover:underline" href={`/umowy/${cid}`}>Umowa nr {us[0].contract.number}</Link> · {us[0].contract.seller_name ?? us[0].contract.counterparty}</b>
            <span className="text-sm text-muted">{us.length} szt. w drodze{us[0].location ? ` · do ${us[0].location.name}` : ""}</span>
          </div>
          <ul className="space-y-1 text-sm">
            {us.map((u) => (
              <li key={u.id}><label className="flex items-center gap-2"><input type="checkbox" name="unit" value={u.id} defaultChecked className="h-4 w-4" /> {u.variant.product.title} · <b>{u.variant.option}</b> <span className="font-mono text-xs text-muted">{u.code}</span></label></li>
            ))}
          </ul>
          <SubmitButton pendingText="Przyjmuję…">Przyjmij zaznaczone</SubmitButton>
        </form>
      ))}
    </div>
  );
}
