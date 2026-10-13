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

export type ExclusionRule = { kind: string; value: string; vat: "margin" | "23" };

/** Reguły wykluczeń ze stawką na paragon (bez migracji 0045 – wszystkie jako marża). */
export async function loadExclusionRules(db: SupabaseClient): Promise<ExclusionRule[]> {
  let { data, error } = await db.from("catalog_exclusions").select("kind, value, vat");
  if (error) ({ data } = await db.from("catalog_exclusions").select("kind, value"));
  // Bez migracji 0045: jak dotąd 23%, poza regułami „rope” / „sznur” (marża).
  return ((data ?? []) as { kind: string; value: string; vat?: string }[]).map((r) => ({
    kind: r.kind, value: String(r.value).trim(),
    vat: r.vat ? (r.vat === "23" ? "23" : "margin") : /rope|sznur/i.test(String(r.value)) ? "margin" : "23",
  }));
}

/** Stawka pozycji wykluczonej z magazynu (np. sznurówki rope → marża). Bez pasującej reguły – marża. */
export function exclusionVat(rules: ExclusionRule[], sku: string | null | undefined, title: string | null | undefined): "margin" | "23" {
  const t = (title ?? "").toLowerCase();
  const s = (sku ?? "").trim().toUpperCase();
  const hit = rules.find((r) => (r.kind === "title_contains" && t.includes(r.value.toLowerCase())) || (r.kind === "sku_prefix" && !!s && s.startsWith(r.value.toUpperCase())));
  return hit?.vat ?? "margin";
}
