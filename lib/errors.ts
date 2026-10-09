/** Czytelny opis błędu – także dla błędów Supabase (zwykłe obiekty z polem message, nie Error). */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object") {
    const o = e as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
    if (typeof o.message === "string") {
      return [o.message, o.details, o.hint].filter((x) => typeof x === "string" && x).join(" – ") + (o.code ? ` (${o.code})` : "");
    }
    try {
      return JSON.stringify(e);
    } catch {
      /* ignorujemy */
    }
  }
  return String(e);
}
