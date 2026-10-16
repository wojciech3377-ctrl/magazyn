/**
 * Wyszukiwarki: każde wpisane słowo musi wystąpić w którymś z pól, w dowolnym miejscu i dowolnej kolejności
 * („jordan mocha” znajdzie „Air Jordan 1 Retro High OG Mocha”).
 */

/** Słowa z pola wyszukiwania – bez znaków, które psują filtr PostgREST. */
export function searchWords(text: string | null | undefined, max = 6): string[] {
  const clean = String(text ?? "").replace(/[,()*%\\"'`:;{}[\]]/g, " ").replace(/\s+/g, " ").trim();
  return [...new Set(clean.split(" ").filter(Boolean))].slice(0, max);
}

/**
 * Wyrażenie do `.or(...)`: każde słowo pasuje do któregoś z pól (ilike), wszystkie słowa naraz.
 * `extra` – dodatkowe alternatywy dla całego zapytania (np. `variant_id.in.(...)`, `number.eq.12`).
 * Pusta lista słów i brak extra → null (bez filtra).
 */
export function wordsOr(columns: string[], words: string[], extra: string[] = []): string | null {
  const per = words.map((w) => `or(${columns.map((c) => `${c}.ilike.*${w}*`).join(",")})`);
  const all = per.length === 0 ? [] : per.length === 1 ? [per[0]] : [`and(${per.join(",")})`];
  const parts = [...all, ...extra];
  return parts.length ? parts.join(",") : null;
}

/** To samo w przeglądarce / w pamięci: czy tekst (np. tytuł + SKU) zawiera wszystkie słowa. */
export function matchesWords(haystack: string, words: string[]) {
  const h = haystack.toLocaleLowerCase("pl");
  return words.every((w) => h.includes(w.toLocaleLowerCase("pl")));
}
