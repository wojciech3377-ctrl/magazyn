import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { CONTRACT_TYPE, dateOnly, money } from "@/lib/labels";
import { Notice, PageHeader, Pagination, Pill } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { markPaid } from "./actions";

const PER_PAGE = 100;

const TABS = [
  { key: "", label: "Wszystkie", categories: [] as string[] },
  { key: "accepted", label: "Zaakceptowane – w drodze / do opłaty", categories: ["in_transit", "to_pay"] },
  { key: "done", label: "Gotowe", categories: ["done"] },
  { key: "pending", label: "Oczekujące", categories: ["pending"] },
  { key: "rejected", label: "Odrzucone", categories: ["rejected"] },
] as const;

type Row = {
  id: string; number: number | null; type: string; counterparty: string; contract_date: string | null; amount: number | null;
  currency: string | null; file_path: string | null; created_at: string; status: string; source: string | null; template: string | null;
  units_created_at: string | null; units_total: number; units_in_transit: number; category: string; paid_at: string | null;
  items: { title: string; option: string; qty?: number }[] | null;
};

function StatePill({ c }: { c: Row }) {
  if (c.status === "sent") return <Pill tone="amber">czeka na podpis klienta</Pill>;
  if (c.status === "signed" && c.template) return <Pill tone="red">do zatwierdzenia</Pill>;
  if (c.status === "rejected") return <Pill tone="slate">odrzucona</Pill>;
  if (c.status === "cancelled") return <Pill tone="slate">anulowana</Pill>;
  if (c.category === "done") return <Pill tone="green">{c.template ? "opłacona" : "wgrana"}</Pill>;
  if (c.category === "in_transit") return <Pill tone="blue">w drodze ({c.units_in_transit} szt.)</Pill>;
  if (c.source === "general" && !c.units_created_at) return <Pill tone="blue">do przypisania</Pill>;
  return <Pill tone="amber">do opłaty</Pill>;
}

export default async function UmowyPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { supabase, profile } = await requireProfile();
  const page = Math.max(1, Number(sp.strona ?? 1));
  const tab = TABS.some((t) => t.key === sp.kategoria) ? sp.kategoria ?? "" : "";

  let query = supabase
    .from("contract_overview")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range((page - 1) * PER_PAGE, page * PER_PAGE - 1);
  const active = TABS.find((t) => t.key === tab)!;
  if (active.categories.length) query = query.in("category", [...active.categories]);
  if (sp.q) query = query.ilike("counterparty", `%${sp.q.replace(/[%,()]/g, "")}%`);
  if (sp.typ) query = query.eq("type", sp.typ);
  if (sp.plik === "brak") query = query.is("file_path", null);

  const counts = await Promise.all(
    TABS.map((t) => {
      let q = supabase.from("contract_overview").select("id", { count: "exact", head: true });
      if (t.categories.length) q = q.in("category", [...t.categories]);
      return q;
    }),
  );
  const [{ data, count }, { count: noContract }] = await Promise.all([
    query,
    supabase.from("units").select("id", { count: "exact", head: true }).is("contract_id", null).in("status", ["in_stock", "in_transit", "reserved"]),
  ]);
  const rows = (data ?? []) as Row[];
  // Wgrane skany nie mają pozycji – nazwy produktów bierzemy z przypiętych sztuk.
  const scanIds = rows.filter((r) => !r.items?.length && r.units_total > 0).map((r) => r.id);
  const { data: scanUnits } = scanIds.length
    ? await supabase.from("units").select("contract_id, variant:variants(option, product:products(title))").in("contract_id", scanIds)
    : { data: [] };
  const productsOf = new Map<string, string[]>();
  for (const r of rows) productsOf.set(r.id, (r.items ?? []).map((i) => `${i.title} · ${i.option}${(i.qty ?? 1) > 1 ? ` ×${i.qty}` : ""}`));
  for (const u of scanUnits ?? []) {
    const v = u.variant as unknown as { option: string; product: { title: string } };
    productsOf.get(u.contract_id as string)?.push(`${v.product.title} · ${v.option}`);
  }
  const href = (k: string) => `/umowy${k ? `?kategoria=${k}` : ""}`;

  return (
    <>
      <PageHeader
        title="Umowy"
        sub={<Link className="text-accent underline" href="/magazyn?umowa=brak">{noContract} sztuk na stanie bez umowy</Link>}
        actions={
          <>
            <Link className="btn-secondary" href="/umowy/nowa">Wgraj skan umowy</Link>
            <Link className="btn" href="/umowy/z-szablonu">Umowa z szablonu (link do podpisu)</Link>
          </>
        }
      />

      {sp.ok && <div className="mb-4"><Notice tone="ok">{sp.ok}</Notice></div>}
      {sp.blad && <div className="mb-4"><Notice tone="error">{sp.blad}</Notice></div>}
      <nav className="mb-4 flex flex-wrap gap-1 border-b border-line text-sm" aria-label="Kategorie umów">
        {TABS.map((t, i) => (
          <Link
            key={t.key}
            href={href(t.key)}
            className={`-mb-px border-b-2 px-3 py-2 ${tab === t.key ? "border-accent font-medium text-ink" : "border-transparent text-muted hover:text-ink"}`}
          >
            {t.label} <span className="ml-1 rounded bg-panel px-1.5 py-0.5 text-xs tabular-nums">{counts[i].count ?? 0}</span>
          </Link>
        ))}
      </nav>

      <form className="mb-4 flex flex-wrap gap-2" method="get">
        {tab && <input type="hidden" name="kategoria" value={tab} />}
        <input className="input w-64" name="q" defaultValue={sp.q} placeholder="Szukaj po osobie lub firmie" />
        <select className="input w-48" name="typ" defaultValue={sp.typ ?? ""}>
          <option value="">Wszystkie typy</option>
          {Object.entries(CONTRACT_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className="input w-40" name="plik" defaultValue={sp.plik ?? ""}>
          <option value="">Z plikiem i bez</option>
          <option value="brak">bez pliku</option>
        </select>
        <button className="btn">Filtruj</button>
      </form>

      <div className="card overflow-x-auto">
        <table className="table">
          <thead><tr><th>Nr</th><th>Od kogo</th><th>Stan</th><th /><th>Typ</th><th>Data</th>{profile.can_see_prices && <th className="text-right">Kwota</th>}<th>Produkty</th><th>Plik</th></tr></thead>
          <tbody>
            {!rows.length && <tr><td colSpan={9} className="py-10 text-center text-muted">Brak umów w tej kategorii.</td></tr>}
            {rows.map((c) => (
              <tr key={c.id}>
                <td className="tabular-nums text-muted">{c.number}</td>
                <td><Link className="font-medium text-accent hover:underline" href={`/umowy/${c.id}`}>{c.counterparty}</Link></td>
                <td><StatePill c={c} /></td>
                <td>
                  {c.status === "accepted" && !c.paid_at && c.template && (
                    <form action={markPaid}>
                      <input type="hidden" name="id" value={c.id} />
                      <input type="hidden" name="back" value={href(tab)} />
                      <SubmitButton className="btn-secondary px-2.5 py-1 text-xs" pendingText="…">Opłacona</SubmitButton>
                    </form>
                  )}
                </td>
                <td>{CONTRACT_TYPE[c.type]}</td>
                <td className="whitespace-nowrap">{dateOnly(c.contract_date ?? c.created_at)}</td>
                {profile.can_see_prices && <td className="text-right tabular-nums">{c.currency && c.currency !== "PLN" ? `${Number(c.amount ?? 0).toFixed(2)} ${c.currency}` : money(c.amount)}</td>}
                <td className="max-w-80"><Products names={productsOf.get(c.id) ?? []} /></td>
                <td>{c.file_path ? <a className="text-accent hover:underline" href={`/api/umowy/${c.id}/pdf`} target="_blank" rel="noreferrer">otwórz</a> : <span className="text-muted">–</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination page={page} total={count ?? 0} perPage={PER_PAGE} params={{ kategoria: tab || undefined, q: sp.q, typ: sp.typ, plik: sp.plik }} />
    </>
  );
}

/** Nazwy produktów z umowy; przy kilku pozycjach lista zwinięta. */
function Products({ names }: { names: string[] }) {
  if (!names.length) return <span className="text-muted">–</span>;
  if (names.length === 1) return <span className="line-clamp-2 text-sm">{names[0]}</span>;
  return (
    <details className="text-sm">
      <summary className="cursor-pointer"><span className="line-clamp-1 inline">{names[0]}</span> <span className="text-muted">+{names.length - 1}</span></summary>
      <ul className="mt-1 space-y-0.5 text-muted">
        {names.slice(1).map((n, i) => <li key={i}>{n}</li>)}
      </ul>
    </details>
  );
}
