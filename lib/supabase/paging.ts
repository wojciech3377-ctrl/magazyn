/**
 * Supabase (PostgREST) oddaje najwyżej 1000 wierszy na zapytanie – także przy .limit(10000) i z funkcji RPC.
 * Czytamy stronami. Zapytanie musi mieć stałą kolejność (.order(...)), inaczej strony mogą się nakładać.
 */
export async function allPages<T>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
  opts: { size?: number; max?: number } = {},
): Promise<T[]> {
  const size = opts.size ?? 1000;
  const max = opts.max ?? 200_000;
  const out: T[] = [];
  for (let from = 0; from < max; from += size) {
    const { data, error } = await page(from, from + size - 1);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < size) break;
  }
  return out;
}

/**
 * Zapytanie `.in(kolumna, ids)` po kawałkach. Gdy kawałek oddaje pełne 1000 wierszy (limit Supabase),
 * dzielimy go na pół – zamiast po cichu gubić resztę.
 */
export async function inChunksAll<T>(
  ids: (string | number)[],
  fn: (part: (string | number)[]) => PromiseLike<{ data: unknown; error: unknown }>,
  chunk = 200,
): Promise<T[]> {
  const out: T[] = [];
  const run = async (part: (string | number)[]): Promise<void> => {
    const { data, error } = await fn(part);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    if (rows.length >= 1000 && part.length > 1) {
      const half = Math.ceil(part.length / 2);
      await run(part.slice(0, half));
      await run(part.slice(half));
      return;
    }
    out.push(...rows);
  };
  for (let i = 0; i < ids.length; i += chunk) await run(ids.slice(i, i + chunk));
  return out;
}
