/**
 * Uprawnienia pracowników: dostęp do działów aplikacji. Administrator ma dostęp do wszystkiego
 * (także Ustawienia i Pracownicy). Pracownik widzi w menu i otwiera tylko działy zaznaczone w panelu Pracownicy.
 */

export const SECTIONS = [
  { key: "magazyn", label: "Magazyn", href: "/magazyn", desc: "stany, karta sztuki, historia, przesunięcia, inwentaryzacja, metki" },
  { key: "dostawa", label: "Przyjęcie dostawy", href: "/dostawa", desc: "przyjmowanie towaru, zgłoszenia komisantów, rzeczy w drodze" },
  { key: "kasa", label: "Kasa", href: "/kasa", desc: "sprzedaż stacjonarna i paragony" },
  { key: "sprzedaz", label: "Sprzedaż", href: "/sprzedaz", desc: "zamówienia ze sklepów, wysyłka, paragony do zamówień" },
  { key: "faktury", label: "Faktury i JPK", href: "/sprzedaz?widok=faktury", desc: "faktury, KSeF, korekty, JPK" },
  { key: "umowy", label: "Umowy", href: "/umowy", desc: "umowy kupna i komisu" },
  { key: "komisanci", label: "Komisanci", href: "/komisanci", desc: "komisanci, wypłaty, wysyłki do komisantów" },
  { key: "wtb", label: "WTB", href: "/wtb", desc: "lista poszukiwanych modeli" },
  { key: "katalog", label: "Katalog", href: "/katalog", desc: "produkty ze Shopify i własne produkty" },
] as const;

export type Section = (typeof SECTIONS)[number]["key"];
export const SECTION_KEYS = SECTIONS.map((s) => s.key) as Section[];

/** Uprawnienia nowego pracownika, gdy administrator nic nie zaznaczy. */
export const DEFAULT_PERMISSIONS: Section[] = ["magazyn", "dostawa", "kasa", "sprzedaz"];

type WithPerms = { role: string; permissions?: string[] | null };

export function can(profile: WithPerms, section: Section) {
  // Brak listy (migracja 0038 jeszcze nieuruchomiona) – dostęp jak dotąd, do wszystkich działów.
  if (profile.role === "admin" || profile.permissions == null) return true;
  return profile.permissions.includes(section);
}

/** Pierwszy dział, do którego osoba ma dostęp (strona startowa po zalogowaniu). */
export function homeFor(profile: WithPerms) {
  if (profile.role === "admin") return "/magazyn";
  const first = SECTIONS.find((s) => s.key !== "faktury" && can(profile, s.key)) ?? SECTIONS.find((s) => can(profile, s.key));
  return first?.href ?? "/brak-dostepu";
}

/** Dział strony po adresie (do menu i przekierowań). */
export function sectionOfPath(path: string): Section | "ustawienia" | "pracownicy" | null {
  if (path.startsWith("/sprzedaz/faktury")) return "faktury";
  const top = path.split("/")[1] ?? "";
  if (top === "ustawienia" || top === "pracownicy") return top;
  return (SECTION_KEYS as string[]).includes(top) ? (top as Section) : null;
}
