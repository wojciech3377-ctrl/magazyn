import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { money } from "@/lib/labels";
import { Notice, PageHeader, Pill } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { createAdminClient } from "@/lib/supabase/admin";
import { consignmentFee, consignorBalance, consignorUnits } from "@/lib/consignment";
import { saveConsignmentFee, saveConsignor } from "./actions";

export default async function KomisanciPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { supabase, profile } = await requireProfile();
  const db = createAdminClient();
  const [{ data: consignors }, { data: open }, fee] = await Promise.all([
    supabase.from("consignors").select("*").order("name"),
    supabase.from("consignor_shipments").select("consignor_id").eq("status", "requested"),
    consignmentFee(db),
  ]);
  const openBy = new Map<string, number>();
  for (const o of open ?? []) openBy.set(o.consignor_id as string, (openBy.get(o.consignor_id as string) ?? 0) + 1);
  const stats = new Map<string, { onStock: number; sold: number; balance: number }>();
  for (const c of consignors ?? []) {
    const units = await consignorUnits(db, c.id as string);
    const bal = await consignorBalance(db, c.id as string, units);
    stats.set(c.id as string, {
      onStock: units.filter((u) => ["in_stock", "in_transit", "reserved", "consignor_hold"].includes(u.status)).length,
      sold: units.filter((u) => ["sold", "shipped"].includes(u.status)).length,
      balance: bal.balance,
    });
  }

  return (
    <>
      <PageHeader title="Komisanci" sub="Rzeczy w komisie, wypłaty i zlecenia wysyłki. Komisant z kontem widzi swój panel pod tym samym adresem aplikacji." />
      {sp.ok && <div className="mb-4"><Notice tone="ok">{sp.ok}</Notice></div>}
      {sp.blad && <div className="mb-4"><Notice tone="error">{sp.blad}</Notice></div>}
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="card min-w-0 overflow-x-auto lg:col-span-2">
          <table className="table">
            <thead><tr><th>Komisant</th><th>Kontakt</th><th className="text-right">Na stanie</th><th className="text-right">Sprzedane</th>{profile.can_see_prices && <th className="text-right">Do wypłaty</th>}<th /></tr></thead>
            <tbody>
              {!consignors?.length && <tr><td colSpan={6} className="py-10 text-center text-muted">Brak komisantów.</td></tr>}
              {consignors?.map((c) => {
                const st = stats.get(c.id) ?? { onStock: 0, sold: 0, balance: 0 };
                return (
                  <tr key={c.id}>
                    <td className="font-medium"><Link className="text-accent hover:underline" href={`/komisanci/${c.id}`}>{c.name}</Link>{c.user_id && <span className="ml-1 text-xs text-muted">(ma konto)</span>}</td>
                    <td className="text-xs text-muted">{[c.email, c.phone].filter(Boolean).join(" · ")}</td>
                    <td className="text-right tabular-nums">{st.onStock}</td>
                    <td className="text-right tabular-nums">{st.sold}</td>
                    {profile.can_see_prices && <td className="text-right tabular-nums">{money(st.balance)}</td>}
                    <td>{openBy.get(c.id) ? <Pill tone="amber">wysyłka: {openBy.get(c.id)}</Pill> : null}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="space-y-5">
          <form action={saveConsignor} className="card space-y-3 p-4">
            <h2 className="h2">Dodaj komisanta</h2>
            <div><label className="label" htmlFor="name">Imię i nazwisko / firma</label><input className="input" id="name" name="name" required /></div>
            <div><label className="label" htmlFor="email">E-mail</label><input className="input" id="email" name="email" type="email" /></div>
            <div><label className="label" htmlFor="phone">Telefon</label><input className="input" id="phone" name="phone" /></div>
            <div><label className="label" htmlFor="bank_account">Konto do wypłat</label><input className="input" id="bank_account" name="bank_account" /></div>
            <div><label className="label" htmlFor="notes">Notatki</label><input className="input" id="notes" name="notes" /></div>
            <SubmitButton>Dodaj</SubmitButton>
          </form>
          {profile.role === "admin" && (
            <form action={saveConsignmentFee} className="card flex flex-wrap items-end gap-2 p-4">
              <div><label className="label" htmlFor="fee">Opłata za wysyłkę na inny adres (zł)</label><input className="input w-32" id="fee" name="fee" inputMode="decimal" defaultValue={fee.toFixed(2)} /></div>
              <SubmitButton className="btn-secondary">Zapisz</SubmitButton>
            </form>
          )}
        </div>
      </div>
    </>
  );
}
