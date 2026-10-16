import { searchWords, wordsOr } from "@/lib/search";
import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { money } from "@/lib/labels";
import { Notice, PageHeader, Pill } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { createAdminClient } from "@/lib/supabase/admin";
import { consignmentFee, consignorBalance, consignorUnits } from "@/lib/consignment";
import { saveConsignmentFee, saveConsignor } from "./actions";
import { FilterField, ListToolbar } from "@/components/ListToolbar";
import { activeFilters, filterChips } from "@/lib/list-params";

const SORTS: Record<string, string> = { nazwa: "Nazwa A–Z", stan: "Najwięcej na stanie", sprzedane: "Najwięcej sprzedanych", wyplata: "Najwięcej do wypłaty" };

export default async function KomisanciPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { supabase, profile } = await requireProfile();
  const db = createAdminClient();
  const text = (sp.q ?? "").replace(/[%,()*\\]/g, " ").trim();
  let cq = supabase.from("consignors").select("*").order("name");
  const qex = wordsOr(["name", "email", "phone"], searchWords(text));
  if (qex) cq = cq.or(qex);
  if (sp.konto === "tak") cq = cq.not("user_id", "is", null);
  if (sp.konto === "nie") cq = cq.is("user_id", null);
  const [{ data: allConsignors }, { data: open }, fee, { data: intakes }] = await Promise.all([
    cq,
    supabase.from("consignor_shipments").select("consignor_id").eq("status", "requested"),
    consignmentFee(db),
    db.from("consignor_intakes").select("consignor_id, status").in("status", ["review", "sent"]),
  ]);
  const reviewBy = new Map<string, number>();
  const sentBy = new Map<string, number>();
  for (const i of intakes ?? []) { const m = i.status === "review" ? reviewBy : sentBy; m.set(i.consignor_id as string, (m.get(i.consignor_id as string) ?? 0) + 1); }
  const totalReview = [...reviewBy.values()].reduce((a, b) => a + b, 0);
  const totalShip = (open ?? []).length;
  const openBy = new Map<string, number>();
  for (const o of open ?? []) openBy.set(o.consignor_id as string, (openBy.get(o.consignor_id as string) ?? 0) + 1);
  const stats = new Map<string, { onStock: number; sold: number; balance: number }>();
  // Po 8 komisantów naraz (wcześniej po kolei – lista ładowała się tym wolniej, im więcej komisantów).
  const list = allConsignors ?? [];
  for (let i = 0; i < list.length; i += 8) {
    await Promise.all(list.slice(i, i + 8).map(async (c) => {
      const units = await consignorUnits(db, c.id as string);
      const bal = await consignorBalance(db, c.id as string, units);
      stats.set(c.id as string, {
        onStock: units.filter((u) => ["in_stock", "in_transit", "reserved", "consignor_hold"].includes(u.status)).length,
        sold: units.filter((u) => ["sold", "shipped"].includes(u.status)).length,
        balance: bal.balance,
      });
    }));
  }

  const sort = SORTS[sp.sort ?? ""] ? sp.sort! : "nazwa";
  const st0 = { onStock: 0, sold: 0, balance: 0 };
  const consignors = (allConsignors ?? [])
    .filter((c) => sp.sprawy !== "tak" || openBy.get(c.id) || reviewBy.get(c.id) || sentBy.get(c.id))
    .filter((c) => sp.stan !== "tak" || (stats.get(c.id)?.onStock ?? 0) > 0)
    .sort((a, b) => {
      const x = stats.get(a.id) ?? st0, y = stats.get(b.id) ?? st0;
      if (sort === "stan") return y.onStock - x.onStock;
      if (sort === "sprzedane") return y.sold - x.sold;
      if (sort === "wyplata") return y.balance - x.balance;
      return 0;
    });
  const listParams = { q: sp.q, konto: sp.konto, sprawy: sp.sprawy, stan: sp.stan, sort: sp.sort };

  return (
    <>
      <PageHeader title="Komisanci" sub="Rzeczy w komisie, wypłaty i zlecenia wysyłki. Komisant z kontem widzi swój panel pod tym samym adresem aplikacji." />
      {sp.ok && <div className="mb-4"><Notice tone="ok">{sp.ok}</Notice></div>}
      {sp.blad && <div className="mb-4"><Notice tone="error">{sp.blad}</Notice></div>}
      {(totalReview > 0 || totalShip > 0) && (
        <div className="mb-4 flex flex-wrap gap-2">
          {totalReview > 0 && <Link className="rounded-md border border-bad/40 bg-rose-50 px-3 py-2 text-sm font-medium text-bad hover:bg-rose-100" href="/dostawa?zakladka=akceptacja">Nowe zgłoszenia rzeczy do akceptacji: {totalReview} →</Link>}
          {totalShip > 0 && <span className="rounded-md border border-bad/40 bg-rose-50 px-3 py-2 text-sm font-medium text-bad">Zlecenia wysyłki do komisantów: {totalShip} – otwórz komisanta poniżej</span>}
        </div>
      )}
      <ListToolbar
        q={sp.q}
        placeholder="Imię, firma, e-mail albo telefon"
        sort={{ value: sort, options: Object.entries(SORTS).filter(([k]) => profile.can_see_prices || k !== "wyplata").map(([value, label]) => ({ value, label })) }}
        dirParam={null}
        active={activeFilters(sp, ["konto", "sprawy", "stan"])}
        resetHref="/komisanci"
        chips={filterChips("/komisanci", listParams, {
          q: (v) => `„${v}”`,
          konto: (v) => (v === "tak" ? "z kontem" : "bez konta"),
          sprawy: () => "do obsłużenia",
          stan: () => "z rzeczami na stanie",
        })}
      >
        <FilterField label="Konto w aplikacji">
          <select className="input" name="konto" defaultValue={sp.konto ?? ""}>
            <option value="">Wszyscy</option>
            <option value="tak">Z kontem</option>
            <option value="nie">Bez konta</option>
          </select>
        </FilterField>
        <FilterField label="Sprawy">
          <select className="input" name="sprawy" defaultValue={sp.sprawy ?? ""}>
            <option value="">Wszyscy</option>
            <option value="tak">Zgłoszenia, wysyłki, paczki w drodze</option>
          </select>
        </FilterField>
        <FilterField label="Rzeczy na stanie">
          <select className="input" name="stan" defaultValue={sp.stan ?? ""}>
            <option value="">Wszyscy</option>
            <option value="tak">Tylko z rzeczami na stanie</option>
          </select>
        </FilterField>
      </ListToolbar>
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="card min-w-0 overflow-x-auto lg:col-span-2">
          <table className="table mtable mtable-flow">
            <thead><tr><th>Komisant</th><th>Kontakt</th><th className="text-right">Na stanie</th><th className="text-right">Sprzedane</th>{profile.can_see_prices && <th className="text-right">Do wypłaty</th>}<th /></tr></thead>
            <tbody>
              {!consignors?.length && <tr><td colSpan={6} className="py-10 text-center text-muted">Brak komisantów.</td></tr>}
              {consignors?.map((c) => {
                const st = stats.get(c.id) ?? { onStock: 0, sold: 0, balance: 0 };
                return (
                  <tr key={c.id}>
                    <td className="m-full font-medium"><Link className="text-accent hover:underline" href={`/komisanci/${c.id}`}>{c.name}</Link>{c.user_id && <span className="ml-1 text-xs text-muted">(ma konto)</span>}</td>
                    <td className="m-full text-xs text-muted">{[c.email, c.phone].filter(Boolean).join(" · ")}</td>
                    <td className="text-right tabular-nums"><span className="text-xs text-muted md:hidden">na stanie </span>{st.onStock}</td>
                    <td className="text-right tabular-nums"><span className="text-xs text-muted md:hidden">sprzedane </span>{st.sold}</td>
                    {profile.can_see_prices && <td className="text-right tabular-nums"><span className="text-xs text-muted md:hidden">do wypłaty </span>{money(st.balance)}</td>}
                    <td className="space-x-1 whitespace-nowrap">
                      {openBy.get(c.id) ? <Pill tone="red">wysyłka do komisanta: {openBy.get(c.id)}</Pill> : null}
                      {reviewBy.get(c.id) ? <Link href="/dostawa?zakladka=akceptacja"><Pill tone="red">zgłoszenie: {reviewBy.get(c.id)}</Pill></Link> : null}
                      {sentBy.get(c.id) ? <Link href="/dostawa?zakladka=w-drodze"><Pill tone="blue">paczka w drodze</Pill></Link> : null}
                    </td>
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
