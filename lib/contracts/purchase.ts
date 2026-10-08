/**
 * Umowa kupna (skup od osoby prywatnej) – treść według wzoru Sneakers Depot.
 * Jeden model treści dla podglądu w przeglądarce (strona podpisu) i dla PDF.
 */

export type Company = { name: string; street: string; city: string; nip: string; email: string; payment_days?: number };
export type ContractItem = { title: string; option: string; identifier?: string | null; qty: number; price: number };
export type PurchaseContract = {
  number: number | string;
  date: string; // YYYY-MM-DD
  company: Company;
  seller: { name: string; idNumber: string; address: string; bankAccount: string };
  items: ContractItem[];
  paymentDays: number;
};

export type Run = { text: string; bold?: boolean };
export type Block =
  | { kind: "date"; text: string; note: string }
  | { kind: "title"; text: string }
  | { kind: "section"; text: string }
  | { kind: "p"; runs: Run[]; gap?: number }
  | { kind: "signatures" }
  | { kind: "footer"; text: string };

export function formatPln(n: number) {
  return new Intl.NumberFormat("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n) + " zł";
}

const ONES = ["", "jeden", "dwa", "trzy", "cztery", "pięć", "sześć", "siedem", "osiem", "dziewięć"];
const TEENS = ["dziesięć", "jedenaście", "dwanaście", "trzynaście", "czternaście", "piętnaście", "szesnaście", "siedemnaście", "osiemnaście", "dziewiętnaście"];
const TENS = ["", "", "dwadzieścia", "trzydzieści", "czterdzieści", "pięćdziesiąt", "sześćdziesiąt", "siedemdziesiąt", "osiemdziesiąt", "dziewięćdziesiąt"];
const HUNDREDS = ["", "sto", "dwieście", "trzysta", "czterysta", "pięćset", "sześćset", "siedemset", "osiemset", "dziewięćset"];
const GROUPS: [string, string, string][] = [
  ["", "", ""],
  ["tysiąc", "tysiące", "tysięcy"],
  ["milion", "miliony", "milionów"],
];

function plural(n: number, forms: [string, string, string]) {
  if (n === 1) return forms[0];
  const d = n % 10, t = n % 100;
  return d >= 2 && d <= 4 && (t < 12 || t > 14) ? forms[1] : forms[2];
}

function triple(n: number) {
  const h = Math.floor(n / 100), rest = n % 100, t = Math.floor(rest / 10), o = rest % 10;
  const parts = [HUNDREDS[h]];
  if (t === 1) parts.push(TEENS[o]);
  else parts.push(TENS[t], ONES[o]);
  return parts.filter(Boolean).join(" ");
}

/** Kwota słownie, np. 900 → „dziewięćset złotych 00/100”. */
export function amountInWords(amount: number) {
  const zl = Math.floor(Math.round(amount * 100) / 100);
  const gr = Math.round((amount - zl) * 100);
  let words = "";
  if (zl === 0) words = "zero";
  let n = zl;
  const parts: string[] = [];
  for (let g = 0; n > 0 && g < GROUPS.length; g++) {
    const chunk = n % 1000;
    if (chunk) {
      const w = g > 0 && chunk === 1 ? "" : triple(chunk);
      parts.unshift([w, g > 0 ? plural(chunk, GROUPS[g]) : ""].filter(Boolean).join(" "));
    }
    n = Math.floor(n / 1000);
  }
  if (parts.length) words = parts.join(" ");
  const currency = plural(zl, ["złoty", "złote", "złotych"]);
  return `${words} ${currency} ${String(gr).padStart(2, "0")}/100`;
}

/** Pozycje: te same produkty, rozmiary i ceny łączą się w jedną linię z ilością (bez IMEI). */
export function groupItems(items: ContractItem[]) {
  const out: ContractItem[] = [];
  for (const i of items) {
    const same = !i.identifier && out.find((o) => !o.identifier && o.title === i.title && o.option === i.option && o.price === i.price);
    if (same) same.qty += i.qty;
    else out.push({ ...i });
  }
  return out;
}

export function purchaseBlocks(c: PurchaseContract): Block[] {
  const items = groupItems(c.items);
  const total = items.reduce((s, i) => s + i.qty * i.price, 0);
  const b = (text: string): Run => ({ text, bold: true });
  const t = (text: string): Run => ({ text });
  const point = (n: number, text: string): Block => ({ kind: "p", runs: [b(`${n}. `), t(text)], gap: 2 });

  return [
    { kind: "date", text: c.date, note: "(data zawarcia umowy)" },
    { kind: "title", text: `UMOWA KUPNA NR${c.number} zawarta pomiędzy:` },
    { kind: "p", runs: [b("Kupujący:")], gap: 8 },
    { kind: "p", runs: [t(c.company.name)] },
    { kind: "p", runs: [t(`${c.company.street}, ${c.company.city}`)] },
    { kind: "p", runs: [t(`NIP: ${c.company.nip}`)] },
    { kind: "p", runs: [b("Sprzedający:")], gap: 8 },
    { kind: "p", runs: [t(`${c.seller.name}, PESEL/NR DOWODU: ${c.seller.idNumber}`)] },
    { kind: "p", runs: [t(c.seller.address)] },
    { kind: "section", text: "§ 1" },
    { kind: "p", runs: [b("1. Sprzedawca oświadcza, że jest właścicielem ruchomości (model, rozmiar, cena)")] },
    ...items.map((i, idx): Block => ({
      kind: "p",
      runs: [t(
        `${idx + 1}. ${i.title}, rozmiar: ${i.option}, ilość: ${i.qty} szt., cena jedn.: ${formatPln(i.price)}, wartość: ${formatPln(i.qty * i.price)}` +
          (i.identifier ? `, IMEI/nr seryjny: ${i.identifier}` : ""),
      )],
    })),
    { kind: "p", runs: [b(`2. Kupujący zapłaci Sprzedawcy za ww. przedmioty cenę brutto w wysokości ${formatPln(total)}`)], gap: 2 },
    { kind: "p", runs: [t(`(Słownie: ${amountInWords(total)})`)] },
    { kind: "p", runs: [b(`3. Zapłata nastąpi: Przelew do ${c.paymentDays} dni od daty dostarczenia towaru na nr konta ${c.seller.bankAccount}`)], gap: 2 },
    { kind: "section", text: "§ 2" },
    point(1, "Sprzedawca oświadcza, że towar jest niezniszczony, pozbawiony wad fizycznych, prawnych oraz praw i obciążeń osób trzecich. Jego jakość odpowiada jakości towaru zaprezentowanego Kupującemu na fotografiach lub informacjach uprzednio przesłanych, a kondycja została dokładnie opisana."),
    point(2, "Sprzedawca oświadcza, że sprzedawany towar jest produktem kolekcjonerskim lub używanym w myśl art. 120. Ust 1 [Podatek od towarów i usług]"),
    point(3, "Produkt kolekcjonerski, czyli produkt o wartości wyższej niż pierwotna wartość producenta, ograniczony limitami produkcji oraz zakupu, a jego zakupu mogła dokonać tylko osoba fizyczna na własny użytek, posiadający wartości w myśl art. 120. Ust 1 pkt 2b [Podatek od towarów i usług]"),
    point(4, "Produkt używany czyli produkt spełniający wymogi w myśl art. 120. Ust 1 pkt 4 [Podatek od towarów i usług]"),
    point(5, "Sprzedawca oświadcza iż towar nie znajduje się w bieżącej sprzedaży producenta, a możliwość jego zakupu występuje tylko na rynku wtórnym, i jest w jego posiadaniu min. 6 miesięcy."),
    point(6, "Towar ujęty niniejszą umową sprzedaży jest sprzedawany zgodnie ze specjalnymi zasadami dotyczącymi towarów kolekcjonerskich i antyków lub towarów używanych w myśl art. 120. Ust 4. [Podatek od towarów i usług]"),
    point(7, "Sprzedawca oświadcza że nie posiada prawa do odliczenia podatku VAT towaru określonego § 1. 1."),
    point(8, "Sprzedawca sprzedaje, a Kupujący kupuje towar określony w § 1. 1"),
    point(9, "Kupujący zobowiązuje się do zapłaty na rzecz Sprzedawcy kwoty określonej w § 1. 2."),
    point(10, "Przeniesienie własności towaru następuje z chwilą jego wydania Kupującemu."),
    { kind: "section", text: "§ 3" },
    point(1, "Wszelkie zmiany niniejszej umowy wymagają dla swej ważności formy pisemnej."),
    point(2, "W sprawach nieuregulowanych zastosowanie znajdują przepisy Kodeksu cywilnego."),
    point(3, "Umowę sporządzono w dwóch jednobrzmiących egzemplarzach, po jednym dla każdej ze stron."),
    { kind: "signatures" },
    {
      kind: "footer",
      text:
        "Informujemy, że zgodnie z art. 13 ogólnego rozporządzenia o ochronie danych osobowych z dnia 27 kwietnia 2016 r. (Dz. U UE.L.2016.119.1), " +
        "dalej zwanego RODO oraz Ustawa z dnia 29 sierpnia 1997 r. o ochronie danych osobowych (Dz. U z 2016 r. poz. 922 z późn. zm.) podpisując umowę " +
        "zgadzasz się na podanie danych osobowych, które będą przetwarzane w celu jej realizacji umowy oraz rozliczeń zamówień przez sklep " +
        `${c.company.name} z siedzibą przy ul. ${c.company.street}, ${c.company.city}, o numerze NIP ${c.company.nip}. ` +
        `Wszystkie zapytania prosimy kierować drogą elektroniczną pod adres: ${c.company.email}`,
    },
  ];
}

export function contractTotal(items: ContractItem[]) {
  return items.reduce((s, i) => s + i.qty * i.price, 0);
}
