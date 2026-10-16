import type { SupabaseClient } from "@supabase/supabase-js";
import { inChunksAll } from "@/lib/supabase/paging";

/**
 * Umowa „zajęta”: ma już tyle rzeczy w magazynie (także sprzedanych / w drodze), ile pozycji ma umowa
 * (umowa bez listy pozycji – jedna rzecz). Rzeczy wycofane i oddane komisantowi nie zajmują umowy.
 */
const RELEASED = "(removed,consignor_returned)";

type Row = { id: string; number: number | null; counterparty: string | null; contract_date: string | null; items: { qty?: number }[] | null };
export type ContractChoice = { id: string; label: string; counterparty: string | null; contract_date: string | null };

const capacity = (items: Row["items"]) => Math.max(1, (items ?? []).reduce((n, i) => n + Math.max(1, Math.floor(Number(i?.qty ?? 1)) || 1), 0));

/** Umowy do wyboru: tylko z wolnym miejscem (plus `keep` – np. umowa już przypięta do tej sztuki). */
export async function freeContracts(db: SupabaseClient, opts: { keep?: (string | null)[]; limit?: number } = {}): Promise<ContractChoice[]> {
  const { data } = await db.from("contracts").select("id, number, counterparty, contract_date, items")
    .not("status", "in", "(cancelled,rejected)").order("created_at", { ascending: false }).limit(opts.limit ?? 300);
  const rows = (data ?? []) as Row[];
  const used = await inChunksAll<{ contract_id: string }>(rows.map((r) => r.id), (part) =>
    db.from("units").select("contract_id").in("contract_id", part as string[]).not("status", "in", RELEASED));
  const count = new Map<string, number>();
  for (const u of used) count.set(u.contract_id, (count.get(u.contract_id) ?? 0) + 1);
  const keep = new Set((opts.keep ?? []).filter((x): x is string => !!x));
  return rows
    .filter((r) => keep.has(r.id) || (count.get(r.id) ?? 0) < capacity(r.items))
    .map((r) => ({
      id: r.id, counterparty: r.counterparty, contract_date: r.contract_date,
      label: [r.number ? `nr ${r.number}` : null, r.counterparty ?? "umowa"].filter(Boolean).join(" · "),
    }));
}

/** Czy do umowy można przypiąć `adding` kolejnych rzeczy (poza `unitIds`, które już mogą do niej należeć). Zwraca błąd albo null. */
export async function contractTakenError(db: SupabaseClient, contractId: string, adding: number, unitIds: string[] = []): Promise<string | null> {
  const { data: c } = await db.from("contracts").select("id, number, counterparty, status, items").eq("id", contractId).maybeSingle();
  if (!c) return "Nie ma takiej umowy.";
  if (["cancelled", "rejected"].includes(c.status as string)) return "Ta umowa jest anulowana albo odrzucona.";
  let q = db.from("units").select("code").eq("contract_id", contractId).not("status", "in", RELEASED).limit(50);
  if (unitIds.length) q = q.not("id", "in", `(${unitIds.join(",")})`);
  const { data: others } = await q;
  const cap = capacity(c.items as Row["items"]);
  if ((others ?? []).length + adding > cap) {
    const name = [c.number ? `nr ${c.number}` : null, c.counterparty].filter(Boolean).join(" · ");
    return `Umowa ${name} jest już zajęta (${(others ?? []).map((o) => o.code).join(", ") || "inne rzeczy"}${cap > 1 ? ` – ma ${cap} pozycji` : ""}). Wybierz inną umowę albo najpierw odepnij ją od tamtej rzeczy.`;
  }
  return null;
}
