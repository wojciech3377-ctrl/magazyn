import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Kwota zakupu sztuki z dołączonej umowy.
 * – Sztuka bez kwoty (pusta albo 0) dostaje kwotę z umowy według `expectedPrices` (pozycja tej sztuki / rozmiaru,
 *   „kwota za każdą rzecz”, jedna rzecz na umowie). Komis: „kwota komisanta”, własne: „cena zakupu”.
 * – Sztuka z własną kwotą ją zachowuje (Magazyn), a JPK bierze kwotę z umowy – tylko informacja.
 * – Gdy z umowy nie wiadomo, ile kosztowała ta rzecz (kwota łączna za kilka rzeczy) – podpowiedź, co zrobić.
 */
export type PriceResult = { updated: string[]; problems: string[]; notes: string[]; masked?: boolean };

type C = { id: string; amount_per_item?: boolean | null; amount: number | string | null; items: { unit_id?: string | null; variant_id?: string | null; price?: number | string; qty?: number }[] | null; currency: string | null; number: number | null; doc_number: string | null; template: string | null; type: string | null };
type U = { id: string; code: string; variant_id: string; owner_type: string; purchase_price: number | string | null; payout_amount: number | string | null; purchase_currency?: string | null };

const fmtFor = (currency: string | null) => (n: number) => `${n.toFixed(2).replace(".", ",")} ${!currency || currency === "PLN" ? "zł" : currency === "EUR" ? "EUR" : currency}`;
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
const same = (a: number, b: number) => Math.abs(a - b) < 0.005;

export async function inheritContractPrice(db: SupabaseClient, contractId: string, unitIds?: string[]): Promise<PriceResult> {
  const out: PriceResult = { updated: [], problems: [], notes: [] };
  // Osoba bez dostępu do cen – komunikaty bez kwot (kwoty zapisują się normalnie).
  try {
    const { data: claims } = await db.auth.getClaims();
    const uid = claims?.claims?.sub;
    if (uid) {
      const { data: me } = await db.from("profiles").select("can_see_prices").eq("id", uid).maybeSingle();
      out.masked = !me?.can_see_prices;
    }
  } catch {
    // klient serwera bez zalogowanej osoby – pełne komunikaty
  }
  const [{ data: c }, { data: list }] = await Promise.all([
    db.from("contracts").select("*").eq("id", contractId).maybeSingle(),
    db.from("units").select("*").eq("contract_id", contractId),
  ]);
  const ct = c as C | null;
  const units = (list ?? []) as U[];
  if (!ct || !units.length) return out;
  const invoice = ct.type === "invoice";
  const label = invoice ? (ct.doc_number ? `fakturze ${ct.doc_number}` : "fakturze") : ct.template && ct.number ? `umowie NR${ct.number}` : ct.doc_number ? `umowie ${ct.doc_number}` : "umowie";
  // Kwoty w walucie umowy (tak jak w JPK).
  const zl = fmtFor(ct.currency);
  const field = (u: U) => (u.owner_type === "consignment" ? "payout_amount" : "purchase_price") as "payout_amount" | "purchase_price";
  const fieldName = (u: U) => (u.owner_type === "consignment" ? "kwota komisanta" : "cena zakupu");
  // 0 zł to brak kwoty (np. wpisane przez pomyłkę) – też dostaje kwotę z umowy.
  const current = (u: U) => { const n = num(u[field(u)]); return n === 0 ? null : n; };
  const check = new Set(unitIds?.length ? unitIds : units.map((u) => u.id));

  const { expected, items, amount } = expectedPrices(ct, units);
  const perItem = !!ct.amount_per_item;
  if (!perItem && invoice && !items.length && units.length === 1 && amount !== null && current(units[0]) === null && check.has(units[0].id)) {
    out.notes.push(`Faktura na ${zl(amount)} – wpisz kwotę zakupu ${units[0].code} (faktura zwykle obejmuje kilka rzeczy, więc cała kwota nie jest przepisywana).`);
  }
  for (const u of units) {
    // Sztuka miała już swoją kwotę (wpisaną bez umowy = w złotych) – zostaje w swojej walucie, nie w walucie umowy.
    if (check.has(u.id) && current(u) !== null && !u.purchase_currency && ct.currency && ct.currency !== "PLN") {
      await db.from("units").update({ purchase_currency: "PLN" }).eq("id", u.id).then(() => null, () => null);
      u.purchase_currency = "PLN";
    }
    const want = expected.get(u.id);
    if (want === undefined || !check.has(u.id)) continue;
    const have = current(u);
    if (have === null) {
      // Waluta kwoty = waluta umowy (np. 35 EUR), żeby w Magazynie nie wyglądało jak 35 zł.
      let { error } = await db.from("units").update({ [field(u)]: want, purchase_currency: ct.currency === "EUR" ? "EUR" : null }).eq("id", u.id);
      if (error && /purchase_currency/.test(error.message)) ({ error } = await db.from("units").update({ [field(u)]: want }).eq("id", u.id));
      if (error) out.problems.push(`${u.code}: nie udało się zapisać kwoty z umowy (${error.message}).`);
      else { out.updated.push(u.code); u[field(u)] = want; }
    } else if (!same(have, want)) {
      const own = fmtFor(u.purchase_currency ?? null);
      out.notes.push(`${u.code}: w Magazynie zostaje ${fieldName(u)} ${own(have)}, a w JPK będzie kwota podana w ${label}: ${zl(want)}.`);
    }
  }

  // Sztuka bez kwoty, a z umowy nie wiadomo, ile kosztowała (np. kwota łączna za kilka rzeczy) – podpowiedź, co zrobić.
  const unknown = units.filter((u) => check.has(u.id) && current(u) === null && !expected.has(u.id));
  if (unknown.length && !out.notes.some((n) => n.startsWith("Faktura na"))) {
    const why = amount === null
      ? `${label} nie ma kwoty`
      : `na ${label} ${units.length % 10 >= 2 && units.length % 10 <= 4 && (units.length % 100 < 12 || units.length % 100 > 14) ? "są" : "jest"} ${units.length} rzeczy na łącznie ${zl(amount)} i nie wiadomo, ile kosztowała która`;
    out.notes.push(`${unknown.map((u) => u.code).join(", ")}: bez kwoty zakupu – ${why}. Zaznacz w umowie „Kwota za każdą rzecz” (jeśli każda rzecz kosztowała tyle samo), wpisz pozycje z cenami albo wpisz kwotę przy sztuce.`);
  }
  return out;
}

/**
 * Kwota z umowy dla każdej sztuki (bez zapisu) – ta sama reguła w Magazynie, w JPK i na karcie sztuki:
 * 1. pozycja umowy tej sztuki (unit_id),
 * 2. pozycja tego rozmiaru (variant_id) – także pozycja, której sztuki nie ma już na umowie (np. podmieniona),
 * 3. „Kwota za każdą rzecz” – każda pozostała sztuka ma kwotę umowy,
 * 4. pozostałe pozycje z ceną, których sztuk nie ma już na umowie: jedna pozycja na jedną sztukę albo wszystkie w tej samej cenie,
 * 5. jedna rzecz na umowie (nie faktura) – cała kwota umowy.
 * Pozycja z ilością > 1 obejmuje tyle sztuk. Ceny wpisane przy sztukach w Magazynie nie mają tu znaczenia.
 */
export function expectedPrices(ct: Pick<C, "amount" | "items" | "amount_per_item"> & { type?: string | null }, units: Pick<U, "id" | "variant_id">[]) {
  // Pozycje bez ceny (0 – np. rzeczy z katalogu dodane do skanu umowy) nic nie mówią o kwocie.
  // Przedmioty faktury wpisane ręcznie (bez sztuki i rozmiaru z katalogu) to tylko opis – nie ustalają kwot sztuk.
  const items = (ct.items ?? []).filter((i) => (num(i.price) ?? 0) > 0 && (i.unit_id || i.variant_id));
  const left = items.map((i) => Math.max(1, Math.floor(Number(i.qty ?? 1)) || 1));
  const onContract = new Set(units.map((u) => u.id));
  const orphan = (it: (typeof items)[number]) => !it.unit_id || !onContract.has(it.unit_id);
  const expected = new Map<string, number>();
  const take = (u: { id: string }, k: number) => { left[k]--; expected.set(u.id, num(items[k].price)!); };
  for (const u of units) {
    const k = items.findIndex((it, x) => left[x] > 0 && it.unit_id === u.id);
    if (k >= 0) take(u, k);
  }
  for (const u of units) {
    if (expected.has(u.id)) continue;
    const k = items.findIndex((it, x) => left[x] > 0 && orphan(it) && it.variant_id === u.variant_id);
    if (k >= 0) take(u, k);
  }
  const amount = num(ct.amount);
  // „Kwota za każdą rzecz”: każda pozostała sztuka ma tę kwotę.
  if (amount !== null && ct.amount_per_item) for (const u of units) if (!expected.has(u.id)) expected.set(u.id, amount);
  // Pozycje bez swojej sztuki → sztuki bez kwoty: gdy jest dokładnie jedna taka para albo wszystkie pozycje mają tę samą cenę.
  const rest = units.filter((u) => !expected.has(u.id));
  const spare = items.map((it, x) => ({ it, x })).filter(({ it, x }) => left[x] > 0 && orphan(it));
  if (rest.length && spare.length) {
    const prices = new Set(spare.map(({ it }) => num(it.price)));
    const slots = spare.reduce((n, { x }) => n + left[x], 0);
    if (prices.size === 1 || (rest.length === 1 && slots === 1)) {
      for (const u of rest) {
        const s = spare.find(({ x }) => left[x] > 0);
        if (!s) break;
        take(u, s.x);
      }
    }
  }
  // Jedna rzecz na umowie: cała kwota. Faktura – nie (zwykle obejmuje kilka rzeczy, a rzeczy dopina się po kolei).
  if (units.length === 1 && !expected.has(units[0].id) && !items.length && amount !== null && ct.type !== "invoice") expected.set(units[0].id, amount);
  return { expected, items, amount };
}

/** Krótki komunikat do paska na górze strony. */
export function priceMessage(r: PriceResult) {
  if (r.masked) {
    // Bez kwot: tylko które sztuki i co zrobić.
    const hide = (t: string) => t.replace(/\d[\d\s.]*(,\d{1,2})?\s?(zł|€|[A-Z]{3}\b)/g, "•••");
    return priceMessage({ ...r, masked: false, notes: r.notes.map(hide), problems: r.problems.map(hide) });
  }
  const parts: string[] = [];
  if (r.updated.length) parts.push(`Kwota zakupu z umowy wpisana: ${r.updated.join(", ")}.`);
  parts.push(...r.notes);
  if (r.problems.length) parts.push(`UWAGA – kwoty się różnią: ${r.problems.join(" ")}`);
  return parts.join(" ");
}
