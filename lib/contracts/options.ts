export type Lang = "pl" | "en";

export const CURRENCIES: { code: string; pl: [string, string, string]; en: [string, string]; minorPl: string }[] = [
  { code: "PLN", pl: ["złoty", "złote", "złotych"], en: ["zloty", "zlotys"], minorPl: "gr" },
  { code: "EUR", pl: ["euro", "euro", "euro"], en: ["euro", "euros"], minorPl: "ct" },
];

export const COUNTRIES: { code: string; pl: string; en: string }[] = [
  { code: "PL", pl: "Polska", en: "Poland" },
  { code: "DE", pl: "Niemcy", en: "Germany" },
  { code: "CZ", pl: "Czechy", en: "Czech Republic" },
  { code: "SK", pl: "Słowacja", en: "Slovakia" },
  { code: "LT", pl: "Litwa", en: "Lithuania" },
  { code: "LV", pl: "Łotwa", en: "Latvia" },
  { code: "EE", pl: "Estonia", en: "Estonia" },
  { code: "UA", pl: "Ukraina", en: "Ukraine" },
  { code: "GB", pl: "Wielka Brytania", en: "United Kingdom" },
  { code: "IE", pl: "Irlandia", en: "Ireland" },
  { code: "FR", pl: "Francja", en: "France" },
  { code: "IT", pl: "Włochy", en: "Italy" },
  { code: "ES", pl: "Hiszpania", en: "Spain" },
  { code: "PT", pl: "Portugalia", en: "Portugal" },
  { code: "NL", pl: "Holandia", en: "Netherlands" },
  { code: "BE", pl: "Belgia", en: "Belgium" },
  { code: "AT", pl: "Austria", en: "Austria" },
  { code: "CH", pl: "Szwajcaria", en: "Switzerland" },
  { code: "SE", pl: "Szwecja", en: "Sweden" },
  { code: "DK", pl: "Dania", en: "Denmark" },
  { code: "NO", pl: "Norwegia", en: "Norway" },
  { code: "FI", pl: "Finlandia", en: "Finland" },
  { code: "HU", pl: "Węgry", en: "Hungary" },
  { code: "RO", pl: "Rumunia", en: "Romania" },
  { code: "US", pl: "Stany Zjednoczone", en: "United States" },
  { code: "OTHER", pl: "Inny kraj", en: "Other country" },
];

export function countryName(code: string | null | undefined, lang: Lang = "pl") {
  const c = COUNTRIES.find((x) => x.code === code);
  return c ? c[lang] : code ?? "";
}

/** Numer konta: polski (26 cyfr, opcjonalnie z PL) albo IBAN z poprawną sumą kontrolną. Zwraca znormalizowany numer albo błąd. */
export function normalizeAccount(input: string): { value?: string; error?: string } {
  const s = input.toUpperCase().replace(/[\s-]/g, "");
  if (/^\d+$/.test(s)) {
    if (s.length !== 26) return { error: `Polski numer konta ma 26 cyfr – wpisano ${s.length}.` };
    return ibanOk(`PL${s}`) ? { value: `PL${s}` } : { error: "Numer konta jest niepoprawny (błędna suma kontrolna) – sprawdź cyfry." };
  }
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return { error: "Wpisz numer konta w formacie IBAN (np. PL… albo DE…)." };
  if (s.startsWith("PL") && s.length !== 28) return { error: `Polski numer konta ma 26 cyfr – wpisano ${s.length - 2}.` };
  if (!ibanOk(s)) return { error: "Numer konta jest niepoprawny (błędna suma kontrolna) – sprawdź cyfry." };
  return { value: s };
}

function ibanOk(iban: string) {
  const r = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of r) {
    const v = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

/** Numer konta wyświetlamy tak, jak wpisał go sprzedający. */
export function formatAccount(account: string | null | undefined) {
  return (account ?? "").trim();
}
