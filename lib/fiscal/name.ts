/** Najdłuższa nazwa towaru na paragonie fiskalnym (limit drukarek). */
export const FISCAL_NAME_MAX = 40;

/**
 * Nazwa na paragon: model + rozmiar w 40 znakach. Gdy całość jest za długa, skracana jest nazwa modelu,
 * a rozmiar / wariant zostaje na końcu (np. „Nike Air Force 1 Low Rope Black La… 44.5” → bez wielokropka).
 */
export function receiptName(title: string, option?: string | null) {
  const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  const t = clean(title);
  const o = clean(option ?? "");
  const full = o ? `${t} ${o}` : t;
  if (full.length <= FISCAL_NAME_MAX) return full || "Towar";
  if (!o || o.length > 15) return full.slice(0, FISCAL_NAME_MAX).trim();
  return `${t.slice(0, FISCAL_NAME_MAX - o.length - 1).trim()} ${o}`;
}
