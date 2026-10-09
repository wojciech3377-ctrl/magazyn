import "server-only";
import ExcelJS from "exceljs";
import type { JpkLine } from "./jpk";

const YELLOW = "FFFFFF00";
const RED = "FFFF0000";
const GREEN = "FF92D050";

/** Data dokumentu jako prawdziwa data Excela (dzień według czasu polskiego). */
function plDate(iso: string | null): Date | "" {
  if (!iso) return "";
  const [y, m, d] = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw" }).format(new Date(iso)).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function currencyNote(c: string | null) {
  if (!c || c === "PLN") return "";
  return c === "EUR" ? "EURO" : c;
}

/**
 * Plik JPK w układzie arkuszy księgowej: „Paragony” (nazwa, kwota, grupa VAT, paragon, data) i „Faktury”
 * (nazwa, kwota, nr FV, data); dane zakupu z umowy. Wiersze z umową w obcej walucie na żółto,
 * zwroty / nieodebrane pobrania na czerwono.
 */
export async function jpkWorkbook(lines: JpkLine[]) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Magazyn";
  wb.created = new Date();

  const receipts = lines.filter((l) => l.kind !== "invoice");
  const invoices = lines.filter((l) => l.kind === "invoice");

  addSheet(wb, "Paragony", ["LP", "Nazwa przedmiotu", "Kwota", "Grupa VAT", "PARAGON", "DATA", "Uwagi", "Data zakupu", "Kwota zakupu", "Numer umowy", "Uwagi"],
    [6, 44, 10, 10, 11, 12, 16, 13, 12, 16, 26],
    receipts.map((l, i) => [i + 1, l.name, l.price, l.vat, numOrText(l.docNumber), plDate(l.docDate), "",
      plDate(l.contractDate), l.purchasePrice, l.contractNumber ?? "", [l.saleNote, currencyNote(l.currency)].filter(Boolean).join(" · ")]),
    receipts);
  addSheet(wb, "Faktury", ["LP", "Nazwa przedmiotu", "Kwota", "NR FV", "data", "Uwagi", "Data zakupu", "Kwota zakupu", "Numer umowy", "Uwagi"],
    [6, 44, 10, 16, 12, 16, 13, 12, 16, 26],
    invoices.map((l, i) => [i + 1, l.name, l.price, l.docNumber ?? "", plDate(l.docDate), "", plDate(l.contractDate), l.purchasePrice, l.contractNumber ?? "", [l.saleNote, currencyNote(l.currency)].filter(Boolean).join(" · ")]),
    invoices);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

function numOrText(v: string | null) {
  if (!v) return "";
  return /^\d{1,9}$/.test(v) ? Number(v) : v;
}

function addSheet(wb: ExcelJS.Workbook, name: string, header: string[], widths: number[], rows: (string | number | Date | null)[][], lines: JpkLine[]) {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = header.map((h, i) => ({ header: h, width: widths[i] }));
  const head = ws.getRow(1);
  head.font = { bold: false };
  head.eachCell((c) => {
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GREEN } };
    c.border = { bottom: { style: "thin" } };
  });
  rows.forEach((r, i) => {
    const row = ws.addRow(r.map((v) => (v === null ? "" : v)));
    const l = lines[i];
    const fill = l.saleNote ? RED : l.currency && l.currency !== "PLN" ? YELLOW : null;
    row.eachCell({ includeEmpty: true }, (c, col) => {
      if (col > header.length) return;
      if (fill) c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
      c.border = { top: { style: "thin", color: { argb: "FFBFBFBF" } }, bottom: { style: "thin", color: { argb: "FFBFBFBF" } }, left: { style: "thin", color: { argb: "FFBFBFBF" } }, right: { style: "thin", color: { argb: "FFBFBFBF" } } };
    });
  });
  // Kwoty jako liczby z dwoma miejscami.
  for (const col of [3, name === "Paragony" ? 9 : 8]) ws.getColumn(col).numFmt = "#,##0.##";
  for (const col of name === "Paragony" ? [6, 8] : [5, 7]) {
    ws.getColumn(col).numFmt = "dd.mm.yyyy";
    ws.getColumn(col).alignment = { horizontal: "right" };
  }
  ws.getColumn(header.length).alignment = { horizontal: "right" };
}
