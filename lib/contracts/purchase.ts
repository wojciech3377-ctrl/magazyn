/**
 * Umowa kupna (skup od osoby prywatnej) – treść według wzoru Sneakers Depot.
 * Jeden model treści dla podglądu w przeglądarce (PL albo EN) i dla PDF (zawsze PL – wersja wiążąca).
 */
import { countryName, CURRENCIES, formatAccount, type Lang } from "./options";

export type Company = { name: string; street: string; city: string; nip: string; email: string; payment_days?: number };
export type ContractItem = { title: string; option: string; identifier?: string | null; qty: number; price: number };
export type PurchaseContract = {
  number: number | string;
  date: string; // YYYY-MM-DD
  company: Company;
  seller: { name: string; idNumber: string; address: string; bankAccount: string; country?: string | null };
  items: ContractItem[];
  paymentDays: number;
  paymentMethod?: "transfer" | "cash" | null;
  currency?: string | null;
};

export type Run = { text: string; bold?: boolean };
export type Block =
  | { kind: "date"; text: string; note: string; extra?: string }
  | { kind: "title"; text: string }
  | { kind: "section"; text: string }
  | { kind: "p"; runs: Run[]; gap?: number }
  | { kind: "signatures"; buyer: string; seller: string }
  | { kind: "footer"; text: string };

const PLACEHOLDER = "…………………";

export function formatMoney(n: number, currency?: string | null, lang: Lang = "pl") {
  const num = new Intl.NumberFormat(lang === "pl" ? "pl-PL" : "en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  if (!currency) return `${num} ${PLACEHOLDER}`;
  return currency === "PLN" && lang === "pl" ? `${num} zł` : `${num} ${currency}`;
}

/** Zgodność wstecz: kwota w złotych. */
export function formatPln(n: number) {
  return formatMoney(n, "PLN");
}

// ───────── Kwota słownie (PL i EN) ─────────

const ONES = ["", "jeden", "dwa", "trzy", "cztery", "pięć", "sześć", "siedem", "osiem", "dziewięć"];
const TEENS = ["dziesięć", "jedenaście", "dwanaście", "trzynaście", "czternaście", "piętnaście", "szesnaście", "siedemnaście", "osiemnaście", "dziewiętnaście"];
const TENS = ["", "", "dwadzieścia", "trzydzieści", "czterdzieści", "pięćdziesiąt", "sześćdziesiąt", "siedemdziesiąt", "osiemdziesiąt", "dziewięćdziesiąt"];
const HUNDREDS = ["", "sto", "dwieście", "trzysta", "czterysta", "pięćset", "sześćset", "siedemset", "osiemset", "dziewięćset"];
const GROUPS: [string, string, string][] = [
  ["", "", ""],
  ["tysiąc", "tysiące", "tysięcy"],
  ["milion", "miliony", "milionów"],
  ["miliard", "miliardy", "miliardów"],
];

function plural(n: number, forms: [string, string, string]) {
  if (n === 1) return forms[0];
  const d = n % 10, t = n % 100;
  return d >= 2 && d <= 4 && (t < 12 || t > 14) ? forms[1] : forms[2];
}

function triplePl(n: number) {
  const h = Math.floor(n / 100), rest = n % 100, t = Math.floor(rest / 10), o = rest % 10;
  const parts = [HUNDREDS[h]];
  if (t === 1) parts.push(TEENS[o]);
  else parts.push(TENS[t], ONES[o]);
  return parts.filter(Boolean).join(" ");
}

function wordsPl(n: number) {
  if (n === 0) return "zero";
  const parts: string[] = [];
  for (let g = 0; n > 0 && g < GROUPS.length; g++) {
    const chunk = n % 1000;
    if (chunk) {
      const w = g > 0 && chunk === 1 ? "" : triplePl(chunk);
      parts.unshift([w, g > 0 ? plural(chunk, GROUPS[g]) : ""].filter(Boolean).join(" "));
    }
    n = Math.floor(n / 1000);
  }
  return parts.join(" ");
}

const EN_ONES = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const EN_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
function tripleEn(n: number) {
  const h = Math.floor(n / 100), rest = n % 100;
  const parts: string[] = [];
  if (h) parts.push(`${EN_ONES[h]} hundred`);
  if (rest) parts.push(rest < 20 ? EN_ONES[rest] : [EN_TENS[Math.floor(rest / 10)], EN_ONES[rest % 10]].filter(Boolean).join("-"));
  return parts.join(" ");
}
function wordsEn(n: number) {
  if (n === 0) return "zero";
  const names = ["", "thousand", "million", "billion"];
  const parts: string[] = [];
  for (let g = 0; n > 0 && g < names.length; g++) {
    const chunk = n % 1000;
    if (chunk) parts.unshift([tripleEn(chunk), names[g]].filter(Boolean).join(" "));
    n = Math.floor(n / 1000);
  }
  return parts.join(" ");
}

/** Kwota słownie, np. 900 PLN → „dziewięćset złotych 00/100”. */
export function amountInWords(amount: number, currency: string | null = "PLN", lang: Lang = "pl") {
  const cents = Math.round(amount * 100);
  const whole = Math.floor(cents / 100);
  const minor = String(cents % 100).padStart(2, "0");
  const cur = CURRENCIES.find((c) => c.code === currency);
  if (lang === "en") {
    const name = cur ? (whole === 1 ? cur.en[0] : cur.en[1]) : "";
    return `${wordsEn(whole)} ${name} ${minor}/100`.replace(/\s+/g, " ").trim();
  }
  const name = cur ? plural(whole, cur.pl) : PLACEHOLDER;
  return `${wordsPl(whole)} ${name} ${minor}/100`;
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

export function contractTotal(items: ContractItem[]) {
  return items.reduce((s, i) => s + i.qty * i.price, 0);
}

// ───────── Treść ─────────

const TEXT = {
  pl: {
    dateNote: "(data zawarcia umowy)",
    country: "Kraj sprzedającego",
    title: (n: string | number) => `UMOWA KUPNA NR${n} zawarta pomiędzy:`,
    buyer: "Kupujący:",
    seller: "Sprzedający:",
    idLabel: "PESEL/NR DOWODU",
    s1p1: "1. Sprzedawca oświadcza, że jest właścicielem ruchomości (model, rozmiar, cena)",
    item: (i: ContractItem, idx: number, cur: string | null | undefined) =>
      `${idx + 1}. ${i.title}, rozmiar: ${i.option}, ilość: ${i.qty} szt., cena jedn.: ${formatMoney(i.price, cur)}, wartość: ${formatMoney(i.qty * i.price, cur)}` +
      (i.identifier ? `, IMEI/nr seryjny: ${i.identifier}` : ""),
    s1p2: (total: string) => `2. Kupujący zapłaci Sprzedawcy za ww. przedmioty cenę brutto w wysokości ${total}`,
    words: (w: string) => `(Słownie: ${w})`,
    payTransfer: (days: number, acc: string) => `3. Zapłata nastąpi: Przelew do ${days} dni od daty dostarczenia towaru na nr konta ${acc}`,
    payCash: "3. Zapłata nastąpi: Gotówką, przy wydaniu towaru Kupującemu.",
    payUnknown: `3. Zapłata nastąpi: ${PLACEHOLDER}`,
    s2: [
      "Sprzedawca oświadcza, że towar jest niezniszczony, pozbawiony wad fizycznych, prawnych oraz praw i obciążeń osób trzecich. Jego jakość odpowiada jakości towaru zaprezentowanego Kupującemu na fotografiach lub informacjach uprzednio przesłanych, a kondycja została dokładnie opisana.",
      "Sprzedawca oświadcza, że sprzedawany towar jest produktem kolekcjonerskim lub używanym w myśl art. 120. Ust 1 [Podatek od towarów i usług]",
      "Produkt kolekcjonerski, czyli produkt o wartości wyższej niż pierwotna wartość producenta, ograniczony limitami produkcji oraz zakupu, a jego zakupu mogła dokonać tylko osoba fizyczna na własny użytek, posiadający wartości w myśl art. 120. Ust 1 pkt 2b [Podatek od towarów i usług]",
      "Produkt używany czyli produkt spełniający wymogi w myśl art. 120. Ust 1 pkt 4 [Podatek od towarów i usług]",
      "Sprzedawca oświadcza iż towar nie znajduje się w bieżącej sprzedaży producenta, a możliwość jego zakupu występuje tylko na rynku wtórnym, i jest w jego posiadaniu min. 6 miesięcy.",
      "Towar ujęty niniejszą umową sprzedaży jest sprzedawany zgodnie ze specjalnymi zasadami dotyczącymi towarów kolekcjonerskich i antyków lub towarów używanych w myśl art. 120. Ust 4. [Podatek od towarów i usług]",
      "Sprzedawca oświadcza że nie posiada prawa do odliczenia podatku VAT towaru określonego § 1. 1.",
      "Sprzedawca sprzedaje, a Kupujący kupuje towar określony w § 1. 1",
      "Kupujący zobowiązuje się do zapłaty na rzecz Sprzedawcy kwoty określonej w § 1. 2.",
      "Przeniesienie własności towaru następuje z chwilą jego wydania Kupującemu.",
    ],
    s3: [
      "Wszelkie zmiany niniejszej umowy wymagają dla swej ważności formy pisemnej.",
      "W sprawach nieuregulowanych zastosowanie znajdują przepisy Kodeksu cywilnego.",
      "Umowę sporządzono w dwóch jednobrzmiących egzemplarzach, po jednym dla każdej ze stron.",
    ],
    signBuyer: "Kupujący",
    signSeller: "Sprzedający",
    footer: (c: Company) =>
      "Informujemy, że zgodnie z art. 13 ogólnego rozporządzenia o ochronie danych osobowych z dnia 27 kwietnia 2016 r. (Dz. U UE.L.2016.119.1), " +
      "dalej zwanego RODO oraz Ustawa z dnia 29 sierpnia 1997 r. o ochronie danych osobowych (Dz. U z 2016 r. poz. 922 z późn. zm.) podpisując umowę " +
      "zgadzasz się na podanie danych osobowych, które będą przetwarzane w celu jej realizacji umowy oraz rozliczeń zamówień przez sklep " +
      `${c.name} z siedzibą przy ul. ${c.street}, ${c.city}, o numerze NIP ${c.nip}. Wszystkie zapytania prosimy kierować drogą elektroniczną pod adres: ${c.email}`,
  },
  en: {
    dateNote: "(date of the agreement)",
    country: "Seller's country",
    title: (n: string | number) => `PURCHASE AGREEMENT NO. ${n} concluded between:`,
    buyer: "Buyer:",
    seller: "Seller:",
    idLabel: "PESEL/ID NUMBER",
    s1p1: "1. The Seller declares that they are the owner of the goods (model, size, price)",
    item: (i: ContractItem, idx: number, cur: string | null | undefined) =>
      `${idx + 1}. ${i.title}, size: ${i.option}, quantity: ${i.qty} pcs, unit price: ${formatMoney(i.price, cur, "en")}, value: ${formatMoney(i.qty * i.price, cur, "en")}` +
      (i.identifier ? `, IMEI/serial no.: ${i.identifier}` : ""),
    s1p2: (total: string) => `2. The Buyer will pay the Seller a gross price of ${total} for the above items`,
    words: (w: string) => `(In words: ${w})`,
    payTransfer: (days: number, acc: string) => `3. Payment: bank transfer within ${days} days of delivery of the goods to account no. ${acc}`,
    payCash: "3. Payment: in cash, upon handing the goods over to the Buyer.",
    payUnknown: `3. Payment: ${PLACEHOLDER}`,
    s2: [
      "The Seller declares that the goods are undamaged and free from physical and legal defects and from any rights and encumbrances of third parties. Their quality corresponds to the goods presented to the Buyer in photos or information sent beforehand, and their condition has been described accurately.",
      "The Seller declares that the goods sold are a collectible or a used product within the meaning of Art. 120(1) of the Polish VAT Act.",
      "A collectible product is a product worth more than the manufacturer's original value, limited in production and purchase, which could only be bought by a natural person for their own use, having value within the meaning of Art. 120(1)(2b) of the Polish VAT Act.",
      "A used product is a product meeting the requirements of Art. 120(1)(4) of the Polish VAT Act.",
      "The Seller declares that the goods are no longer sold by the manufacturer, can only be bought on the secondary market, and have been in the Seller's possession for at least 6 months.",
      "The goods covered by this agreement are sold under the special rules for collectibles and antiques or used goods within the meaning of Art. 120(4) of the Polish VAT Act.",
      "The Seller declares that they have no right to deduct VAT on the goods specified in § 1.1.",
      "The Seller sells, and the Buyer buys, the goods specified in § 1.1.",
      "The Buyer undertakes to pay the Seller the amount specified in § 1.2.",
      "Ownership of the goods passes when the goods are handed over to the Buyer.",
    ],
    s3: [
      "Any amendments to this agreement must be made in writing to be valid.",
      "Matters not regulated here are governed by the Polish Civil Code.",
      "The agreement has been drawn up in two identical copies, one for each party.",
    ],
    signBuyer: "Buyer",
    signSeller: "Seller",
    footer: (c: Company) =>
      "Under Art. 13 of the General Data Protection Regulation of 27 April 2016 (GDPR), by signing this agreement you agree that your personal data will be processed " +
      `to perform the agreement and settle orders by ${c.name}, ${c.street}, ${c.city}, tax ID (NIP) ${c.nip}. Please send any questions to: ${c.email}`,
  },
} as const;

export function purchaseBlocks(c: PurchaseContract, lang: Lang = "pl"): Block[] {
  const T = TEXT[lang];
  const items = groupItems(c.items);
  const total = contractTotal(items);
  const b = (text: string): Run => ({ text, bold: true });
  const t = (text: string): Run => ({ text });
  const point = (n: number, text: string): Block => ({ kind: "p", runs: [b(`${n}. `), t(text)], gap: 2 });
  const pay = c.paymentMethod === "cash" ? T.payCash
    : c.paymentMethod === "transfer" ? T.payTransfer(c.paymentDays, formatAccount(c.seller.bankAccount) || PLACEHOLDER)
    : T.payUnknown;
  const country = c.seller.country ? countryName(c.seller.country, lang) : PLACEHOLDER;

  return [
    { kind: "date", text: c.date, note: T.dateNote, extra: `${T.country}: ${country}` },
    { kind: "title", text: T.title(c.number) },
    { kind: "p", runs: [b(T.buyer)], gap: 8 },
    { kind: "p", runs: [t(c.company.name)] },
    { kind: "p", runs: [t(`${c.company.street}, ${c.company.city}`)] },
    { kind: "p", runs: [t(`NIP: ${c.company.nip}`)] },
    { kind: "p", runs: [b(T.seller)], gap: 8 },
    { kind: "p", runs: [t(`${c.seller.name}, ${T.idLabel}: ${c.seller.idNumber}`)] },
    { kind: "p", runs: [t(c.seller.country && c.seller.country !== "PL" ? `${c.seller.address}, ${country}` : c.seller.address)] },
    { kind: "section", text: "§ 1" },
    { kind: "p", runs: [b(T.s1p1)] },
    ...items.map((i, idx): Block => ({ kind: "p", runs: [t(T.item(i, idx, c.currency))] })),
    { kind: "p", runs: [b(T.s1p2(formatMoney(total, c.currency, lang)))], gap: 2 },
    { kind: "p", runs: [t(T.words(amountInWords(total, c.currency ?? null, lang)))] },
    { kind: "p", runs: [b(pay)], gap: 2 },
    { kind: "section", text: "§ 2" },
    ...T.s2.map((x, i) => point(i + 1, x)),
    { kind: "section", text: "§ 3" },
    ...T.s3.map((x, i) => point(i + 1, x)),
    { kind: "signatures", buyer: T.signBuyer, seller: T.signSeller },
    { kind: "footer", text: T.footer(c.company) },
  ];
}
