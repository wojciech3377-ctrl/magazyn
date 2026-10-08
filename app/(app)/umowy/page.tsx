import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { CONTRACT_TYPE, dateOnly, money } from "@/lib/labels";
import { PageHeader, Pagination, Pill } from "@/components/ui";

const PER_PAGE = 100;

export default async function UmowyPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { supabase, profile } = await requireProfile();
  const page = Math.max(1, Number(sp.strona ?? 1));
  let query = supabase
    .from("contracts")
    .select("id, number, type, counterparty, contract_date, amount, file_path, created_at, status, source, units_created_at, units(count)", { count: "exact" })
    .order("created_at", { ascending: false })
    .range((page - 1) * PER_PAGE, page * PER_PAGE - 1);
  if (sp.q) query = query.ilike("counterparty", `%${sp.q.replace(/[%,()]/g, "")}%`);
  if (sp.typ) query = query.eq("type", sp.typ);
  if (sp.plik === "brak") query = query.is("file_path", null);
  if (sp.stan === "czeka") query = query.eq("status", "sent");
  if (sp.stan === "przypisz") query = query.eq("status", "signed").eq("source", "general").is("units_created_at", null);
  const [{ data, count }, { count: noContract }] = await Promise.all([
    query,
    supabase.from("units").select("id", { count: "exact", head: true }).is("contract_id", null).in("status", ["in_stock", "in_transit", "reserved"]),
  ]);

  return (
    <>
      <PageHeader
        title="Umowy"
        sub={<>{count} umów · <Link className="text-accent underline" href="/magazyn?umowa=brak">{noContract} sztuk na stanie bez umowy</Link></>}
        actions={
          <>
            <Link className="btn-secondary" href="/umowy/nowa">Wgraj skan umowy</Link>
            <Link className="btn" href="/umowy/z-szablonu">Umowa z szablonu (link do podpisu)</Link>
          </>
        }
      />
      <form className="mb-4 flex flex-wrap gap-2" method="get">
        <input className="input w-64" name="q" defaultValue={sp.q} placeholder="Szukaj po osobie lub firmie" />
        <select className="input w-48" name="typ" defaultValue={sp.typ ?? ""}>
          <option value="">Wszystkie typy</option>
          {Object.entries(CONTRACT_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className="input w-56" name="stan" defaultValue={sp.stan ?? ""}>
          <option value="">Wszystkie stany</option>
          <option value="czeka">czeka na podpis</option>
          <option value="przypisz">z ogólnego linku – do przypisania</option>
        </select>
        <select className="input w-40" name="plik" defaultValue={sp.plik ?? ""}>
          <option value="">Z plikiem i bez</option>
          <option value="brak">bez pliku</option>
        </select>
        <button className="btn">Filtruj</button>
      </form>
      <div className="card overflow-x-auto">
        <table className="table">
          <thead><tr><th>Nr</th><th>Od kogo</th><th>Stan</th><th>Typ</th><th>Data</th>{profile.can_see_prices && <th className="text-right">Kwota</th>}<th className="text-right">Sztuki</th><th>Plik</th></tr></thead>
          <tbody>
            {!data?.length && <tr><td colSpan={8} className="py-10 text-center text-muted">Brak umów.</td></tr>}
            {data?.map((c) => (
              <tr key={c.id}>
                <td className="tabular-nums text-muted">{c.number}</td>
                <td><Link className="font-medium text-accent hover:underline" href={`/umowy/${c.id}`}>{c.counterparty}</Link></td>
                <td>
                  {c.status === "sent" ? <Pill tone="amber">czeka na podpis</Pill>
                    : c.status === "cancelled" ? <Pill tone="slate">anulowana</Pill>
                    : c.source === "general" && !c.units_created_at ? <Pill tone="blue">do przypisania</Pill>
                    : <Pill tone="green">podpisana</Pill>}
                </td>
                <td>{CONTRACT_TYPE[c.type]}</td>
                <td className="whitespace-nowrap">{dateOnly(c.contract_date)}</td>
                {profile.can_see_prices && <td className="text-right tabular-nums">{money(c.amount)}</td>}
                <td className="text-right tabular-nums">{(c.units as unknown as { count: number }[])[0]?.count ?? 0}</td>
                <td>{c.file_path ? <Pill tone="green">jest</Pill> : <Pill tone="amber">brak pliku</Pill>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination page={page} total={count ?? 0} perPage={PER_PAGE} params={{ q: sp.q, typ: sp.typ, plik: sp.plik, stan: sp.stan }} />
    </>
  );
}
