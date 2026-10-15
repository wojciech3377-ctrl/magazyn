import Link from "next/link";
import { FilterField, ListToolbar } from "@/components/ListToolbar";
import { filterChips } from "@/lib/list-params";
import { requireProfile } from "@/lib/auth";
import { PageHeader, Pagination } from "@/components/ui";
import { describeEvent } from "@/lib/history";
import { dateTime } from "@/lib/labels";

export const metadata = { title: "Historia magazynu" };
const PER_PAGE = 100;

const TYPES: [string, string][] = [
  ["", "Wszystkie zdarzenia"], ["received", "Przyjęcia"], ["sold", "Sprzedaż"], ["status", "Zmiany statusu"], ["contract", "Umowy"],
  ["moved", "Przeniesienia"], ["transfer", "Przesunięcia między magazynami"], ["returned", "Zwroty"], ["edited", "Edycje"],
  ["consignor_returned", "Oddane komisantom"], ["payout", "Wypłaty komisantom"],
];

/** Historia wszystkich sztuk: kto, co i kiedy (przyjęcia, sprzedaż, zmiany, umowy, komis). */
export default async function HistoryPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { supabase } = await requireProfile();
  const page = Math.max(1, Number(sp.strona ?? 1));
  const type = TYPES.some(([k]) => k === sp.typ) ? sp.typ ?? "" : "";
  const owner = sp.wlasciciel === "komis" ? "consignment" : sp.wlasciciel === "wlasne" ? "own" : "";
  const q = (sp.q ?? "").replace(/[%,()*\\]/g, " ").trim();

  let unitIds: string[] | null = null;
  if (q) {
    let uq = supabase.from("units_list").select("id").or(`code.ilike.%${q}%,identifier.ilike.%${q}%,title.ilike.%${q}%,style_sku.ilike.%${q}%,consignor_name.ilike.%${q}%`).limit(300);
    if (owner) uq = uq.eq("owner_type", owner);
    const { data } = await uq;
    unitIds = (data ?? []).map((u) => u.id as string);
  }
  // Właściciel: filtr po sztuce w samym zapytaniu (wcześniej tylko zdarzenia ~300 przypadkowych sztuk).
  let query = supabase.from("unit_events").select(`id, unit_id, type, data, created_at, unit:units${owner ? "!inner" : ""}(id, code, owner_type, consignor:consignors(name), variant:variants(option, product:products(title)))`, { count: "exact" })
    .order("created_at", { ascending: false }).range((page - 1) * PER_PAGE, page * PER_PAGE - 1);
  if (owner) query = query.eq("unit.owner_type", owner);
  if (type) query = query.eq("type", type);
  if (unitIds) query = query.in("unit_id", unitIds.length ? unitIds.slice(0, 300) : ["00000000-0000-0000-0000-000000000000"]);
  const { data, count } = await query;
  type Row = { id: string; unit_id: string; type: string; data: Record<string, unknown> | null; created_at: string; unit: { id: string; code: string; owner_type: string; consignor: { name: string } | null; variant: { option: string; product: { title: string } } | null } | null };
  const dot = { green: "bg-emerald-500", blue: "bg-blue-500", amber: "bg-amber-500", slate: "bg-slate-400", red: "bg-red-500" };

  return (
    <>
      <PageHeader title="Historia magazynu" sub="Wszystko, co działo się ze sztukami: przyjęcia, sprzedaż, zmiany statusu, umowy, przesunięcia, komis i wypłaty." actions={<Link className="btn-secondary" href="/magazyn">Wróć do Magazynu</Link>} />
      <ListToolbar
        q={sp.q}
        placeholder="Kod sztuki, IMEI, nazwa, SKU albo komisant"
        active={[type, sp.wlasciciel].filter(Boolean).length}
        resetHref="/magazyn/historia"
        chips={filterChips("/magazyn/historia", { q: sp.q, typ: type || undefined, wlasciciel: sp.wlasciciel }, {
          q: (v) => `„${v}”`,
          typ: (v) => TYPES.find(([k]) => k === v)?.[1],
          wlasciciel: (v) => (v === "wlasne" ? "tylko własne" : "tylko komis"),
        })}
      >
        <FilterField label="Rodzaj zdarzenia">
          <select className="input" name="typ" defaultValue={type}>{TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        </FilterField>
        <FilterField label="Właściciel">
          <select className="input" name="wlasciciel" defaultValue={sp.wlasciciel ?? ""}><option value="">Własne i komis</option><option value="wlasne">Tylko własne</option><option value="komis">Tylko komis</option></select>
        </FilterField>
      </ListToolbar>
      <Pagination page={page} total={count ?? 0} perPage={PER_PAGE} params={{ q: sp.q, typ: type || undefined, wlasciciel: sp.wlasciciel }} top />
      <div className="card overflow-x-auto">
        <table className="table mtable mtable-flow">
          <thead><tr><th>Kiedy</th><th>Sztuka</th><th>Zdarzenie</th></tr></thead>
          <tbody>
            {!data?.length && <tr><td colSpan={3} className="py-10 text-center text-muted">Brak zdarzeń dla tych filtrów.</td></tr>}
            {((data ?? []) as unknown as Row[]).map((e) => {
              const d = describeEvent(e);
              return (
                <tr key={e.id}>
                  <td className="m-full whitespace-nowrap text-sm text-muted max-md:text-xs">{dateTime(e.created_at)}</td>
                  <td className="m-full min-w-56">
                    {e.unit ? <Link className="font-medium hover:underline" href={`/magazyn/${e.unit.id}`}>{e.unit.variant?.product.title} · {e.unit.variant?.option}</Link> : "–"}
                    <span className="block font-mono text-xs text-muted">{e.unit?.code}{e.unit?.owner_type === "consignment" ? <span className="font-sans"> · komis {e.unit.consignor?.name ?? ""}</span> : ""}</span>
                  </td>
                  <td className="m-full text-sm"><span className="inline-flex items-start gap-2"><span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot[d.tone]}`} /><span><b className="font-medium">{d.title}</b>{d.detail && <span className="text-muted"> · {d.detail}</span>}</span></span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Pagination page={page} total={count ?? 0} perPage={PER_PAGE} params={{ q: sp.q, typ: type || undefined, wlasciciel: sp.wlasciciel }} />
    </>
  );
}
