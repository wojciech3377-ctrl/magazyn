import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Kwota zakupu sztuki z dołączonej umowy.
 * – Sztuka bez kwoty dostaje kwotę z umowy (pozycja umowy tej sztuki / tego rozmiaru, a przy jednej rzeczy – kwota umowy).
 *   Komis: „kwota komisanta”, własne: „cena zakupu”.
 * – Gdy sztuka ma już inną kwotę niż umowa – nic nie zmieniamy, tylko opis błędu: która kwota gdzie i co zrobić.
 * Umowa na kilka rzeczy bez cen pozycji: suma kwot sztuk musi się zgadzać z kwotą umowy; gdy brakuje kwoty
 * tylko jednej sztuce – dostaje resztę.
 */
export type PriceResult = { updated: string[]; problems: string[]; notes: string[] };

type C = { id: string; amount: number | string | null; items: { unit_id?: string | null; variant_id?: string | null; price?: number | string; qty?: number }[] | null; currency: string | null; number: number | null; doc_number: string | null; template: string | null; type: string | null };
type U = { id: string; code: string; variant_id: string; owner_type: string; purchase_price: number | string | null; payout_amount: number | string | null };

const zl = (n: number) => `${n.toFixed(2).replace(".", ",")} zł`;
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
const same = (a: number, b: number) => Math.abs(a - b) < 0.005;

export async function inheritContractPrice(db: SupabaseClient, contractId: string, unitIds?: string[]): Promise<PriceResult> {
  const out: PriceResult = { updated: [], problems: [], notes: [] };
  const [{ data: c }, { data: list }] = await Promise.all([
    db.from("contracts").select("id, amount, items, currency, number, doc_number, template, type").eq("id", contractId).maybeSingle(),
    db.from("units").select("id, code, variant_id, owner_type, purchase_price, payout_amount").eq("contract_id", contractId),
  ]);
  const ct = c as C | null;
  const units = (list ?? []) as U[];
  if (!ct || !units.length) return out;
  const label = ct.template && ct.number ? `umowie NR${ct.number}` : ct.doc_number ? `umowie ${ct.doc_number}` : "umowie";
  if (ct.currency && ct.currency !== "PLN") {
    out.notes.push(`Umowa jest w ${ct.currency} – kwoty zakupu sztuk nie są przepisywane (magazyn liczy w zł).`);
    return out;
  }
  const field = (u: U) => (u.owner_type === "consignment" ? "payout_amount" : "purchase_price") as "payout_amount" | "purchase_price";
  const fieldName = (u: U) => (u.owner_type === "consignment" ? "kwota komisanta" : "cena zakupu");
  const fieldAcc = (u: U) => (u.owner_type === "consignment" ? "kwotę komisanta" : "cenę zakupu");
  const current = (u: U) => num(u[field(u)]);
  const check = new Set(unitIds?.length ? unitIds : units.map((u) => u.id));

  const { expected, items, amount } = expectedPrices(ct, units);
  for (const u of units) {
    const want = expected.get(u.id);
    if (want === undefined || !check.has(u.id)) continue;
    const have = current(u);
    if (have === null) {
      const { error } = await db.from("units").update({ [field(u)]: want }).eq("id", u.id);
      if (error) out.problems.push(`${u.code}: nie udało się zapisać kwoty z umowy (${error.message}).`);
      else { out.updated.push(u.code); u[field(u)] = want; }
    } else if (!same(have, want)) {
      out.problems.push(`${u.code}: ${fieldName(u)} w magazynie to ${zl(have)}, a w ${label}: ${zl(want)}. Kwota nie została zmieniona – sprawdź, która jest dobra, i popraw ${fieldAcc(u)} w sztuce albo kwotę w umowie.`);
    }
  }

  // 3. Kilka rzeczy, kwota umowy bez cen pozycji: suma musi się zgadzać.
  if (!items.length && units.length > 1 && amount !== null) {
    const missing = units.filter((u) => current(u) === null);
    const sum = units.reduce((s, u) => s + (current(u) ?? 0), 0);
    if (missing.length === 1) {
      const rest = Math.round((amount - sum) * 100) / 100;
      const u = missing[0];
      if (rest > 0) {
        const { error } = await db.from("units").update({ [field(u)]: rest }).eq("id", u.id);
        if (!error) out.updated.push(`${u.code} (reszta kwoty umowy)`);
      } else {
        out.problems.push(`${u.code}: brak kwoty, a pozostałe rzeczy na tej umowie mają już razem ${zl(sum)} przy kwocie umowy ${zl(amount)} – nic nie zostaje dla tej sztuki. Sprawdź kwoty.`);
      }
    } else if (missing.length > 1) {
      out.notes.push(`Umowa obejmuje ${units.length} rzeczy na łącznie ${zl(amount)} – wpisz kwoty zakupu przy sztukach (${missing.map((u) => u.code).join(", ")}), razem mają dać ${zl(amount)}.`);
    } else if (!same(sum, amount)) {
      out.problems.push(`Suma kwot zakupu ${units.length} rzeczy na ${label} to ${zl(sum)}, a kwota umowy to ${zl(amount)} (różnica ${zl(Math.abs(sum - amount))}). Popraw kwoty sztuk albo kwotę umowy.`);
    }
  }
  return out;
}

/** Kwota z umowy dla każdej sztuki (bez zapisu): pozycja tej sztuki, pozycja tego rozmiaru, a przy jednej rzeczy – kwota umowy. */
export function expectedPrices(ct: Pick<C, "amount" | "items">, units: Pick<U, "id" | "variant_id">[]) {
  const items = (ct.items ?? []).filter((i) => num(i.price) !== null);
  const used = new Set<number>();
  const expected = new Map<string, number>();
  for (const u of units) {
    const i = items.findIndex((it, k) => !used.has(k) && it.unit_id === u.id);
    if (i >= 0) { used.add(i); expected.set(u.id, num(items[i].price)!); }
  }
  for (const u of units) {
    if (expected.has(u.id)) continue;
    const i = items.findIndex((it, k) => !used.has(k) && !it.unit_id && it.variant_id === u.variant_id);
    if (i >= 0) { used.add(i); expected.set(u.id, num(items[i].price)!); }
  }
  const amount = num(ct.amount);
  if (!items.length && units.length === 1 && amount !== null) expected.set(units[0].id, amount);
  return { expected, items, amount };
}

/** Krótki komunikat do paska na górze strony. */
export function priceMessage(r: PriceResult) {
  const parts: string[] = [];
  if (r.updated.length) parts.push(`Kwota zakupu z umowy wpisana: ${r.updated.join(", ")}.`);
  parts.push(...r.notes);
  if (r.problems.length) parts.push(`UWAGA – kwoty się różnią: ${r.problems.join(" ")}`);
  return parts.join(" ");
}
