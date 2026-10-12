/** Powtarzanie zadań „Do zrobienia”. Daty jako „RRRR-MM-DD”. */
export type Repeat = "none" | "daily" | "weekdays" | "weekly" | "monthly";

export const REPEATS: { key: Repeat; label: string; short: string }[] = [
  { key: "none", label: "Nie powtarzaj", short: "" },
  { key: "daily", label: "Codziennie", short: "codziennie" },
  { key: "weekdays", label: "W dni robocze (pon–pt)", short: "w dni robocze" },
  { key: "weekly", label: "Co tydzień", short: "co tydzień" },
  { key: "monthly", label: "Co miesiąc", short: "co miesiąc" },
];

const toDate = (d: string) => new Date(`${d}T12:00:00Z`);
const fmt = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(day: string, n: number) {
  const d = toDate(day);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
}

function addMonth(day: string) {
  const d = toDate(day);
  const want = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + 1);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(want, last));
  return fmt(d);
}

/** Następny dzień zadania powtarzanego. */
export function nextOccurrence(day: string, repeat: Repeat) {
  if (repeat === "daily") return addDays(day, 1);
  if (repeat === "weekly") return addDays(day, 7);
  if (repeat === "monthly") return addMonth(day);
  if (repeat === "weekdays") {
    let next = addDays(day, 1);
    while ([0, 6].includes(toDate(next).getUTCDay())) next = addDays(next, 1);
    return next;
  }
  return day;
}

/** Termin kolejnego wystąpienia: ten sam odstęp od dnia rozpoczęcia (przy „co miesiąc” – miesiąc później). */
export function nextDue(start: string, due: string | null, repeat: Repeat, nextStart: string) {
  if (!due) return null;
  if (repeat === "monthly") return addMonth(due);
  const gap = Math.round((toDate(due).getTime() - toDate(start).getTime()) / 86400_000);
  return addDays(nextStart, Math.max(0, gap));
}
