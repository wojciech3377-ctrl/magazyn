/** Etykiety aktywnych filtrów („chipsy” z krzyżykiem) – link usuwa dany filtr, resztę zostawia. */
export function filterChips(
  base: string,
  params: Record<string, string | undefined>,
  labels: Record<string, (v: string) => string | null | undefined>,
) {
  const entries = Object.entries(params).filter(([k, v]) => v && k !== "strona") as [string, string][];
  return entries
    .filter(([k]) => labels[k])
    .map(([k, v]) => {
      const label = labels[k](v);
      if (!label) return null;
      const rest = new URLSearchParams(entries.filter(([x]) => x !== k));
      return { label, href: `${base}${rest.size ? `?${rest}` : ""}` };
    })
    .filter((x): x is { label: string; href: string } => !!x);
}

/** Liczba aktywnych filtrów (bez wyszukiwania i sortowania). */
export function activeFilters(params: Record<string, string | undefined>, keys: string[]) {
  return keys.filter((k) => params[k]).length;
}
