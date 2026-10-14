/**
 * Numer paragonu z treści odczytanej z drukarki (kopia elektroniczna) – tak jak na wydruku.
 * ELZAB: w nagłówku „nr dok.000001453”. Inne zapisy: „Nr wydr. 1453”. Wynik: 9 cyfr z zerami (000001453).
 * Uwaga: „#01/KIEROWNIK” w stopce to numer kasy i kasjer – nie numer paragonu.
 */
export function printoutNumber(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const re of [/nr\s*dok\w*\.?\s*:?\s*(\d{1,9})(?!\d)/i, /nr\.?\s*wydr\w*\.?\s*:?\s*(\d{1,9})(?!\d)/i]) {
    const m = text.match(re);
    if (m && Number(m[1]) > 0) return m[1].padStart(9, "0");
  }
  return null;
}
