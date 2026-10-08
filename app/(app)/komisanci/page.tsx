import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { money } from "@/lib/labels";
import { PageHeader } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { saveConsignor } from "./actions";

export default async function KomisanciPage() {
  const { supabase, profile } = await requireProfile();
  const [{ data: consignors }, { data: units }] = await Promise.all([
    supabase.from("consignors").select("*").order("name"),
    supabase.from("consignor_stats").select("consignor_id, on_stock, sold, payout_sold"),
  ]);
  const stats = new Map((units ?? []).map((u) => [u.consignor_id as string, { onStock: Number(u.on_stock), sold: Number(u.sold), toPay: Number(u.payout_sold) }]));

  return (
    <>
      <PageHeader title="Komisanci" sub="Panel dla komisantów i rozliczenia wypłat to etap 2. Tu dodajesz osoby, żeby przyjmować ich towar." />
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="card min-w-0 overflow-x-auto lg:col-span-2">
          <table className="table">
            <thead><tr><th>Komisant</th><th>Kontakt</th><th className="text-right">Na stanie</th><th className="text-right">Sprzedane</th>{profile.can_see_prices && <th className="text-right">Suma cen w komisie (sprzedane)</th>}</tr></thead>
            <tbody>
              {!consignors?.length && <tr><td colSpan={5} className="py-10 text-center text-muted">Brak komisantów.</td></tr>}
              {consignors?.map((c) => {
                const s = stats.get(c.id) ?? { onStock: 0, sold: 0, toPay: 0 };
                return (
                  <tr key={c.id}>
                    <td className="font-medium"><Link className="text-accent hover:underline" href={`/magazyn?wlasciciel=consignment&komisant=${c.id}&status=wszystkie`}>{c.name}</Link></td>
                    <td className="text-xs text-muted">{[c.email, c.phone].filter(Boolean).join(" · ")}</td>
                    <td className="text-right tabular-nums">{s.onStock}</td>
                    <td className="text-right tabular-nums">{s.sold}</td>
                    {profile.can_see_prices && <td className="text-right tabular-nums">{money(s.toPay)}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <form action={saveConsignor} className="card space-y-3 p-4">
          <h2 className="h2">Dodaj komisanta</h2>
          <div><label className="label" htmlFor="name">Imię i nazwisko / firma</label><input className="input" id="name" name="name" required /></div>
          <div><label className="label" htmlFor="email">E-mail</label><input className="input" id="email" name="email" type="email" /></div>
          <div><label className="label" htmlFor="phone">Telefon</label><input className="input" id="phone" name="phone" /></div>
          <div><label className="label" htmlFor="bank_account">Konto do wypłat</label><input className="input" id="bank_account" name="bank_account" /></div>
          <div><label className="label" htmlFor="notes">Notatki</label><input className="input" id="notes" name="notes" /></div>
          <SubmitButton>Dodaj</SubmitButton>
        </form>
      </div>
    </>
  );
}
