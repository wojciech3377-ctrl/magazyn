import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { CONTRACT_TYPE, dateOnly, money } from "@/lib/labels";
import { Field, Notice, PageHeader, StatusBadge } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { attachUnits, deleteContract, detachUnit, replaceFile } from "../actions";
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
      <PageHeader title={c.counterparty} sub={`${CONTRACT_TYPE[c.type]} · ${dateOnly(c.contract_date)}`} actions={<Link className="btn-secondary" href="/umowy">Wróć do listy</Link>} />
      {sp.ok && <div className="mb-4"><Notice tone="ok">{sp.ok}</Notice></div>}
      {sp.blad && <div className="mb-4"><Notice tone="error">{sp.blad}</Notice></div>}
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
