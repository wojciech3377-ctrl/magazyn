/**
 * Faktura w strukturze FA(3) dla KSeF. Pozycje liczone od brutto (art. 106e ust. 7):
 * - 23% VAT: P_9B / P_11A + P_12 = 23, suma netto P_13_1 i VAT P_14_1 z kwot brutto,
 * - procedura marży (towary używane): P_9B / P_11A bez stawki, suma w P_13_11, adnotacja P_PMarzy_3_1.
 */

export type InvoiceParty = {
  name: string;
  nip?: string | null;
  address1?: string | null;   // ulica i numer
  address2?: string | null;   // kod i miasto
  country?: string | null;    // PL
  email?: string | null;
  company?: boolean;
};

export type InvoiceItemInput = { name: string; quantity: number; unit: string; unit_price_gross: number; total_gross: number; vat: "23" | "margin" };

export type InvoiceInput = {
  number: string;
  issueDate: string;          // YYYY-MM-DD
  saleDate: string;
  place: string | null;
  seller: InvoiceParty & { nip: string };
  buyer: InvoiceParty;
  currency: string;
  paymentMethod: "cash" | "card" | "transfer" | "mobile";
  paid: boolean;
  paidAt: string | null;
  dueDate: string | null;
  bankAccount?: string | null;
  items: InvoiceItemInput[];
  createdAt: Date;
};

const PAYMENT_CODE = { cash: 1, card: 2, transfer: 6, mobile: 7 } as const;

const r2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => r2(n).toFixed(2);

export function invoiceTotals(items: InvoiceItemInput[]) {
  const gross23 = r2(items.filter((i) => i.vat === "23").reduce((s, i) => s + i.total_gross, 0));
  const net23 = r2(gross23 / 1.23);
  const vat23 = r2(gross23 - net23);
  const margin = r2(items.filter((i) => i.vat === "margin").reduce((s, i) => s + i.total_gross, 0));
  return { gross23, net23, vat23, margin, total: r2(gross23 + margin) };
}

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;")
    // Znaki sterujące (C0, C1) i niezdefiniowane są odrzucane przez KSeF.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u0084\u0086-\u009F\uFDD0-\uFDEF]/g, "");
}

const el = (tag: string, value: string | number | null | undefined) =>
  value === null || value === undefined || value === "" ? "" : `<${tag}>${esc(String(value))}</${tag}>`;

function address(p: InvoiceParty) {
  if (!p.address1) return "";
  return `<Adres>${el("KodKraju", (p.country || "PL").toUpperCase())}${el("AdresL1", p.address1.slice(0, 512))}${el("AdresL2", p.address2?.slice(0, 512))}</Adres>`;
}

export function onlyDigits(nip: string | null | undefined) {
  return (nip ?? "").replace(/\D/g, "");
}

export function buildFa3(inv: InvoiceInput) {
  const t = invoiceTotals(inv.items);
  const hasMargin = t.margin > 0;
  const buyerNip = onlyDigits(inv.buyer.nip);
  const buyerCountry = (inv.buyer.country || "PL").toUpperCase();
  const buyerId = buyerNip && buyerCountry === "PL"
    ? el("NIP", buyerNip)
    : buyerNip
      ? `${el("KodKraju", buyerCountry)}${el("NrID", inv.buyer.nip?.trim())}`
      : "<BrakID>1</BrakID>";

  const lines = inv.items.map((i, idx) => [
    "<FaWiersz>",
    el("NrWierszaFa", idx + 1),
    el("P_7", i.name.slice(0, 512)),
    el("P_8A", i.unit || "szt."),
    el("P_8B", Number(i.quantity.toFixed(3))),
    el("P_9B", money(i.unit_price_gross)),
    el("P_11A", money(i.total_gross)),
    i.vat === "23" ? el("P_12", "23") : "",
    "</FaWiersz>",
  ].join("")).join("");

  const payment = [
    "<Platnosc>",
    inv.paid ? `${el("Zaplacono", 1)}${el("DataZaplaty", inv.paidAt ?? inv.issueDate)}` : "",
    !inv.paid && inv.dueDate ? `<TerminPlatnosci>${el("Termin", inv.dueDate)}</TerminPlatnosci>` : "",
    el("FormaPlatnosci", PAYMENT_CODE[inv.paymentMethod]),
    inv.paymentMethod === "transfer" && inv.bankAccount && inv.bankAccount.replace(/\s/g, "").length >= 10 ? `<RachunekBankowy>${el("NrRB", inv.bankAccount.replace(/\s/g, ""))}</RachunekBankowy>` : "",
    "</Platnosc>",
  ].join("");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Faktura xmlns="http://crd.gov.pl/wzor/2025/06/25/13775/">',
    "<Naglowek>",
    '<KodFormularza kodSystemowy="FA (3)" wersjaSchemy="1-0E">FA</KodFormularza>',
    "<WariantFormularza>3</WariantFormularza>",
    el("DataWytworzeniaFa", inv.createdAt.toISOString().replace(/\.\d{3}Z$/, "Z")),
    el("SystemInfo", "Magazyn Sneakers Depot"),
    "</Naglowek>",
    "<Podmiot1>",
    `<DaneIdentyfikacyjne>${el("NIP", onlyDigits(inv.seller.nip))}${el("Nazwa", inv.seller.name.slice(0, 512))}</DaneIdentyfikacyjne>`,
    address(inv.seller),
    inv.seller.email ? `<DaneKontaktowe>${el("Email", inv.seller.email)}</DaneKontaktowe>` : "",
    "</Podmiot1>",
    "<Podmiot2>",
    `<DaneIdentyfikacyjne>${buyerId}${el("Nazwa", inv.buyer.name.slice(0, 512))}</DaneIdentyfikacyjne>`,
    address(inv.buyer),
    inv.buyer.email ? `<DaneKontaktowe>${el("Email", inv.buyer.email)}</DaneKontaktowe>` : "",
    "<JST>2</JST><GV>2</GV>",
    "</Podmiot2>",
    "<Fa>",
    el("KodWaluty", inv.currency),
    el("P_1", inv.issueDate),
    el("P_1M", inv.place),
    el("P_2", inv.number),
    inv.saleDate !== inv.issueDate ? el("P_6", inv.saleDate) : "",
    t.gross23 > 0 ? `${el("P_13_1", money(t.net23))}${el("P_14_1", money(t.vat23))}` : "",
    hasMargin ? el("P_13_11", money(t.margin)) : "",
    el("P_15", money(t.total)),
    "<Adnotacje>",
    "<P_16>2</P_16><P_17>2</P_17><P_18>2</P_18><P_18A>2</P_18A>",
    "<Zwolnienie><P_19N>1</P_19N></Zwolnienie>",
    "<NoweSrodkiTransportu><P_22N>1</P_22N></NoweSrodkiTransportu>",
    "<P_23>2</P_23>",
    hasMargin ? "<PMarzy><P_PMarzy>1</P_PMarzy><P_PMarzy_3_1>1</P_PMarzy_3_1></PMarzy>" : "<PMarzy><P_PMarzyN>1</P_PMarzyN></PMarzy>",
    "</Adnotacje>",
    "<RodzajFaktury>VAT</RodzajFaktury>",
    hasMargin ? `<DodatkowyOpis>${el("Klucz", "Procedura")}${el("Wartosc", "procedura marży - towary używane")}</DodatkowyOpis>` : "",
    lines,
    payment,
    "</Fa>",
    "</Faktura>",
  ].join("");
}

/** Wzorzec NIP z FA(3) (TNrNIP) + suma kontrolna. */
export function nipValid(nip: string) {
  if (!/^[1-9]((\d[1-9])|([1-9]\d))\d{7}$/.test(nip)) return false;
  const w = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  return w.reduce((acc, x, i) => acc + x * Number(nip[i]), 0) % 11 === Number(nip[9]);
}
