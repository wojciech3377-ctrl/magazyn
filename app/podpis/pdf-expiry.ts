/**
 * Podpisana umowa (z PESEL, adresem i kontem) jest do pobrania z linku przez 90 dni od zatwierdzenia.
 * Potem link nie pokazuje danych – kopię wysyłamy na prośbę (link mógł trafić do historii przeglądarki, maili, logów).
 */
export const PDF_LINK_DAYS = 90;

export function pdfExpired(acceptedAt: string | null | undefined) {
  if (!acceptedAt) return false;
  return Date.now() - Date.parse(acceptedAt) > PDF_LINK_DAYS * 86400_000;
}
