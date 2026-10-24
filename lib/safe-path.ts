/**
 * Adres powrotu z formularza / linku – tylko ścieżka w tej aplikacji.
 * Odrzuca adresy zewnętrzne, także „//evil.com” i „/\evil.com” (przeglądarka traktuje je jak inną domenę).
 */
export function safePath(value: unknown, fallback: string): string {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v.startsWith("/") || v.startsWith("//") || v.includes("\\") || /[\u0000-\u001f]/.test(v)) return fallback;
  try {
    const base = new URL("https://app.local");
    const url = new URL(v, base);
    return url.origin === base.origin ? url.pathname + url.search + url.hash : fallback;
  } catch {
    return fallback;
  }
}
