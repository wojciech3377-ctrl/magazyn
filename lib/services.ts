import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Wykluczenia z magazynu (usługi, mystery boxy…): reguły z tabeli catalog_exclusions,
 * edytowane w Ustawieniach. Te produkty nie trafiają do katalogu ani do sprzedaży sztuk.
 */
export type Exclusions = { skuPrefixes: string[]; titleContains: string[] };

export async function loadExclusions(db: SupabaseClient): Promise<Exclusions> {
  const { data } = await db.from("catalog_exclusions").select("kind, value");
  const rows = data ?? [];
  return {
    skuPrefixes: rows.filter((r) => r.kind === "sku_prefix").map((r) => String(r.value).trim().toUpperCase()),
    titleContains: rows.filter((r) => r.kind === "title_contains").map((r) => String(r.value).trim().toLowerCase()),
  };
}

export function isExcluded(ex: Exclusions, skus: (string | null | undefined)[], title?: string | null) {
  const t = (title ?? "").toLowerCase();
  if (t && ex.titleContains.some((x) => t.includes(x))) return true;
  return skus.some((sku) => {
    const s = (sku ?? "").trim().toUpperCase();
    return !!s && ex.skuPrefixes.some((p) => s.startsWith(p));
  });
}
