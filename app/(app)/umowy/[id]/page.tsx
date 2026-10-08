import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { CONTRACT_TYPE, dateOnly, money } from "@/lib/labels";
import { Field, Notice, PageHeader, StatusBadge } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { attachUnits, cancelContract, deleteContract, detachUnit, replaceFile, retryFinalize, sendSigningEmail } from "../actions";
import { appUrl } from "@/lib/app-url";
import { mailConfigured } from "@/lib/mail";
import { contractTotal, formatMoney } from "@/lib/contracts/purchase";
import { countryName, formatAccount } from "@/lib/contracts/options";
import { Pill } from "@/components/ui";
import { CopyLink } from "./CopyLink";
import { AssignItems } from "./AssignItems";
import { ContractFileInput } from "@/components/ContractFileInput";

export default async function ContractPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const { supabase, profile } = await requireProfile();
  const { data: c } = await supabase.from("contracts").select("*, consignor:consignors(name)").eq("id", id).maybeSingle();
  if (!c) notFound();
  const { data: units } = await supabase
    .from("units")
    .select("id, code, status, identifier, variant:variants(option, product:products(title))")
    .eq("contract_id", id)
    .order("number");
  let fileUrl: string | null = null;
  if (c.file_path) {
    const { data } = await supabase.storage.from("contracts").createSignedUrl(c.file_path, 600);
    fileUrl = data?.signedUrl ?? null;
  }
  const isImage = /\.(jpe?g|png|webp|heic|heif)$/i.test(c.file_path ?? "");

  return (
    <>
      <PageHeader
        title={c.number ? `Umowa nr ${c.number} · ${c.counterparty}` : c.counterparty}
        sub={`${CONTRACT_TYPE[c.type]} · ${dateOnly(c.contract_date ?? c.created_at)}`}
        actions={
          <>
            {c.template && profile.can_see_prices && <a className="btn-secondary" href={`/api/umowy/${c.id}/pdf`} target="_blank" rel="noreferrer">{c.status === "signed" ? "PDF umowy" : "Podgląd PDF"}</a>}
            <Link className="btn-secondary" href="/umowy">Wróć do listy</Link>
          </>
        }
      />
      {sp.ok && <div className="mb-4"><Notice tone="ok">{sp.ok}</Notice></div>}
      {sp.blad && <div className="mb-4"><Notice tone="error">{sp.blad}</Notice></div>}
      {c.template && <TemplateSection c={c} canSeePrices={profile.can_see_prices} />}
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="min-w-0 space-y-5 lg:col-span-2">
          <section className="card p-4">
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <Field label="Typ">{CONTRACT_TYPE[c.type]}</Field>
              <Field label="Data">{dateOnly(c.contract_date)}</Field>
              {profile.can_see_prices && <Field label="Kwota">{money(c.amount)}</Field>}
              {c.consignor && <Field label="Komisant">{(c.consignor as { name: string }).name}</Field>}
            </div>
            {c.notes && <p className="mt-3 text-sm text-muted">{c.notes}</p>}
          </section>

          <section className="card overflow-x-auto">
            <div className="flex items-center justify-between p-4 pb-2"><h2 className="h2">Sztuki na tej umowie ({units?.length ?? 0})</h2></div>
            <table className="table">
              <thead><tr><th>Kod</th><th>Produkt</th><th>Rozmiar</th><th>Status</th><th /></tr></thead>
              <tbody>
                {!units?.length && <tr><td colSpan={5} className="py-6 text-center text-muted">Brak przypiętych sztuk.</td></tr>}
                {units?.map((u) => {
                  const v = u.variant as unknown as { option: string; product: { title: string } };
                  return (
                    <tr key={u.id}>
                      <td className="font-mono text-xs"><Link className="text-accent hover:underline" href={`/magazyn/${u.id}`}>{u.code}</Link>{u.identifier && <span className="block text-muted">{u.identifier}</span>}</td>
                      <td>{v.product.title}</td>
                      <td className="font-medium">{v.option}</td>
                      <td><StatusBadge status={u.status} /></td>
                      <td className="text-right">
                        <form action={detachUnit}>
                          <input type="hidden" name="id" value={c.id} />
                          <input type="hidden" name="unit_id" value={u.id} />
                          <button className="text-sm text-bad hover:underline">Odepnij</button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <form action={attachUnits} className="flex flex-wrap gap-2 border-t border-line p-4">
              <input type="hidden" name="id" value={c.id} />
              <input className="input flex-1 font-mono" name="units" placeholder="Dopnij sztuki: kody S000123 lub IMEI" aria-label="Kody sztuk" />
              <SubmitButton className="btn-secondary">Dopnij</SubmitButton>
            </form>
          </section>
        </div>

        <div className="min-w-0 space-y-5">
          <section className="card space-y-3 p-4">
            <h2 className="h2">Plik</h2>
            {fileUrl ? (
              <>
                {isImage ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <a href={fileUrl} target="_blank" rel="noreferrer"><img src={fileUrl} alt="Skan umowy" className="w-full rounded border border-line" /></a>
                ) : (
                  <a className="btn-secondary w-full" href={fileUrl} target="_blank" rel="noreferrer">Otwórz {c.file_name ?? "plik"}</a>
                )}
              </>
            ) : <p className="text-sm text-muted">Brak pliku.</p>}
            <form action={replaceFile} className="space-y-2">
              <input type="hidden" name="id" value={c.id} />
              <ContractFileInput label="Nowy plik" />
              <SubmitButton className="btn-secondary w-full" pendingText="Wgrywam…">{c.file_path ? "Zastąp plik" : "Wgraj plik"}</SubmitButton>
            </form>
          </section>
          {profile.role === "admin" && (
            <form action={deleteContract} className="text-right">
              <input type="hidden" name="id" value={c.id} />
              <SubmitButton className="btn-danger" pendingText="Usuwam…">Usuń umowę</SubmitButton>
            </form>
          )}
        </div>
      </div>
    </>
  );
}

type TemplateContract = {
  id: string; status: string; source: string | null; sign_token: string | null; sign_expires_at: string | null;
  seller_name: string | null; seller_id_number: string | null; seller_address: string | null; seller_bank_account: string | null;
  seller_email: string | null; seller_phone: string | null; signed_at: string | null; signer_ip: string | null;
  payment_days: number | null; units_created_at: string | null; sale_id: string | null;
  payment_method: string | null; currency: string | null; seller_country: string | null;
  items: { title: string; option: string; qty: number; price: number; unit_id?: string; variant_id?: string; identifier?: string | null }[] | null;
};

async function TemplateSection({ c, canSeePrices }: { c: TemplateContract; canSeePrices: boolean }) {
  const { supabase } = await requireProfile();
  const link = c.sign_token ? `${await appUrl()}/podpis/${c.sign_token}` : "";
  const items = c.items ?? [];
  const needsAssign = c.status === "signed" && c.source === "general" && !c.units_created_at;
  const { data: locations } = needsAssign ? await supabase.from("locations").select("id, name, store_id, store:stores(name)").eq("active", true) : { data: [] };
  const { data: sale } = c.sale_id ? await supabase.from("sales").select("order_ref").eq("id", c.sale_id).maybeSingle() : { data: null };
  const smsBody = encodeURIComponent(`Umowa kupna do podpisu: ${link}`);

  return (
    <div className="mb-5 grid gap-5 lg:grid-cols-3">
      <section className="card space-y-3 p-4 lg:col-span-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="h2">Umowa z szablonu</h2>
          {c.status === "sent" && <Pill tone="amber">czeka na podpis</Pill>}
          {c.status === "signed" && <Pill tone="green">podpisana</Pill>}
          {c.status === "cancelled" && <Pill tone="slate">anulowana</Pill>}
          {c.source === "general" && <Pill tone="blue">z ogólnego linku</Pill>}
          {sale && <Pill tone="blue">pod zamówienie {sale.order_ref}</Pill>}
        </div>
        <table className="table">
          <thead><tr><th>Pozycja</th><th>Rozmiar</th><th className="text-right">Ilość</th>{canSeePrices && <th className="text-right">Cena</th>}</tr></thead>
          <tbody>
            {items.map((i, idx) => (
              <tr key={idx}>
                <td>{i.title}{i.identifier && <span className="block font-mono text-xs text-muted">{i.identifier}</span>}</td>
                <td>{i.option}</td>
                <td className="text-right">{i.qty ?? 1}</td>
                {canSeePrices && <td className="text-right tabular-nums">{formatMoney(Number(i.price), c.currency ?? "PLN")}</td>}
              </tr>
            ))}
            {canSeePrices && <tr><td colSpan={3} className="text-right font-medium">Razem</td><td className="text-right font-semibold tabular-nums">{formatMoney(contractTotal(items.map((i) => ({ ...i, qty: Number(i.qty ?? 1), price: Number(i.price) }))), c.currency ?? "PLN")}</td></tr>}
          </tbody>
        </table>
        {c.status === "signed" && !c.units_created_at && !needsAssign && (
          <form action={retryFinalize} className="flex items-center gap-3 border-t border-line pt-3 text-sm">
            <input type="hidden" name="id" value={c.id} />
            <span className="text-warn">Po podpisie nie udało się przypiąć sztuk do umowy.</span>
            <SubmitButton className="btn-secondary" pendingText="…">Spróbuj ponownie</SubmitButton>
          </form>
        )}
        {needsAssign && (
          <div className="space-y-2 border-t border-line pt-3">
            <h3 className="font-medium">Przypisz do katalogu</h3>
            <p className="text-sm text-muted">Klient sam opisał, co sprzedaje. Wybierz właściwy produkt i rozmiar – powstaną sztuki „w drodze” z tą umową.</p>
            <AssignItems
              id={c.id}
              items={items.map((i) => ({ title: i.title, option: i.option, qty: Number(i.qty ?? 1), price: Number(i.price) }))}
              locations={(locations ?? []).map((l) => ({ id: l.id, store_id: l.store_id, label: `${(l.store as unknown as { name: string }).name} · ${l.name}` }))}
            />
          </div>
        )}
      </section>
      <section className="card space-y-3 p-4">
        {c.status === "sent" && link && (
          <>
            <h3 className="font-medium">Link do podpisu</h3>
            <CopyLink link={link} />
            <p className="text-xs text-muted">Ważny do {dateOnly(c.sign_expires_at)}. Sprzedający wpisze swoje dane i podpisze na telefonie.</p>
            <div className="flex flex-wrap gap-2">
              <a className="btn-secondary" href={`sms:${c.seller_phone ?? ""}?&body=${smsBody}`}>Wyślij SMS</a>
              <a className="btn-secondary" href={`https://wa.me/?text=${smsBody}`} target="_blank" rel="noreferrer">WhatsApp</a>
            </div>
            <form action={sendSigningEmail} className="flex gap-2">
              <input type="hidden" name="id" value={c.id} />
              <input className="input" type="email" name="email" defaultValue={c.seller_email ?? ""} placeholder="e-mail sprzedającego" aria-label="E-mail sprzedającego" />
              <SubmitButton className="btn-secondary whitespace-nowrap" pendingText="Wysyłam…" disabled={!mailConfigured()}>E-mail</SubmitButton>
            </form>
            {!mailConfigured() && <p className="text-xs text-muted">Wysyłka e-maili z aplikacji wymaga ustawienia SMTP w Vercel.</p>}
            <form action={cancelContract}>
              <input type="hidden" name="id" value={c.id} />
              <SubmitButton className="text-sm text-bad underline" pendingText="…">Anuluj umowę</SubmitButton>
            </form>
          </>
        )}
        {c.status === "signed" && (
          <div className="space-y-1 text-sm">
            <h3 className="font-medium">Sprzedający</h3>
            <p>{c.seller_name}<br />{c.seller_address}{c.seller_country && c.seller_country !== "PL" ? `, ${countryName(c.seller_country)}` : ""}<br />PESEL/dowód: {c.seller_id_number}</p>
            <p>Zapłata: <b>{c.payment_method === "cash" ? "gotówka" : `przelew – ${formatAccount(c.seller_bank_account)}`}</b>, waluta <b>{c.currency ?? "–"}</b></p>
            <p className="text-muted">{[c.seller_email, c.seller_phone].filter(Boolean).join(" · ")}</p>
            <p className="text-xs text-muted">Podpisano {dateOnly(c.signed_at)}{c.signer_ip ? ` · IP ${c.signer_ip}` : ""}. {c.payment_method !== "cash" && <>Przelew w ciągu {c.payment_days ?? 7} dni od dostarczenia towaru.</>}</p>
          </div>
        )}
      </section>
    </div>
  );
}
