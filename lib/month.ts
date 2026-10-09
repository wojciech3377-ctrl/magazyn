/** Miesiące w strefie Europe/Warsaw (JPK liczy się według polskiej daty dokumentu). */

function warsawOffsetMinutes(utcMs: number) {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Warsaw", timeZoneName: "shortOffset" }).formatToParts(new Date(utcMs)).find((p) => p.type === "timeZoneName")?.value ?? "GMT+1";
  const m = part.match(/GMT([+-]\d+)(?::(\d+))?/);
  return m ? Number(m[1]) * 60 + Math.sign(Number(m[1])) * Number(m[2] ?? 0) : 60;
}

/** Północ czasu polskiego danego dnia jako Date (UTC). */
export function warsawMidnight(y: number, m: number, d = 1) {
  const guess = Date.UTC(y, m - 1, d);
  return new Date(guess - warsawOffsetMinutes(guess) * 60_000);
}

export function currentMonth() {
  const [y, m] = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit" }).format(new Date()).split("-").map(Number);
  return { y, m };
}

export function previousMonthKey() {
  const { y, m } = currentMonth();
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/** „2026-09” → zakres [od, do) w UTC; zły format → poprzedni miesiąc. */
export function monthRange(key: string | undefined) {
  const k = key && /^\d{4}-(0[1-9]|1[0-2])$/.test(key) ? key : previousMonthKey();
  const [y, m] = k.split("-").map(Number);
  return { key: k, from: warsawMidnight(y, m), to: m === 12 ? warsawMidnight(y + 1, 1) : warsawMidnight(y, m + 1) };
}

export function monthLabel(key: string) {
  const [y, m] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("pl-PL", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 15)));
}
