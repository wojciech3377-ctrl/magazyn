import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import QRCode from "qrcode";
import { verificationLink } from "@/lib/ksef/client";

/** Wizualizacja faktury (PDF) z kodem QR KSeF (KOD I) i numerem KSeF pod kodem. */

type Party = { name: string; nip?: string | null; address1?: string | null; address2?: string | null; country?: string | null; email?: string | null; bank_account?: string | null };
type Item = { position: number; name: string; quantity: number; unit: string; unit_price_gross: number; total_gross: number; vat: string };
export type InvoiceForPdf = {
  number: string; issue_date: string; sale_date: string; place: string | null; seller: Party; buyer: Party;
  payment_method: string; paid: boolean; paid_at: string | null; due_date: string | null; currency: string;
  total_gross: number; net_23: number; vat_23: number; margin_total: number; notes: string | null;
  ksef_number: string | null; xml_hash: string | null; status: string; items: Item[];
};

const A4: [number, number] = [595.28, 841.89];
const M = 42;
const PAY: Record<string, string> = { cash: "gotówka", card: "karta płatnicza", transfer: "przelew", mobile: "płatność mobilna (BLIK)" };

let fontCache: { regular: Uint8Array; bold: Uint8Array } | null = null;
async function fonts() {
  if (!fontCache) {
    const dir = path.join(process.cwd(), "lib/contracts/fonts");
    const [regular, bold] = await Promise.all([readFile(path.join(dir, "DejaVuSans.ttf")), readFile(path.join(dir, "DejaVuSans-Bold.ttf"))]);
    fontCache = { regular, bold };
  }
  return fontCache;
}

const pl = (n: number) => new Intl.NumberFormat("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
const date = (d: string | null) => (d ? d.split("-").reverse().join(".") : "–");

function fit(font: PDFFont, text: string, size: number, width: number) {
  if (font.widthOfTextAtSize(text, size) <= width) return [text];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) > width && line) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

export async function renderInvoicePdf(inv: InvoiceForPdf) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const f = await fonts();
  const regular = await doc.embedFont(f.regular, { subset: true });
  const bold = await doc.embedFont(f.bold, { subset: true });
  doc.setTitle(`Faktura ${inv.number}`);
  let page: PDFPage = doc.addPage(A4);
  let y = A4[1] - M;
  const text = (t: string, x: number, size = 9, font = regular, color = rgb(0, 0, 0)) => page.drawText(t, { x, y, size, font, color });
  const grey = rgb(0.4, 0.4, 0.4);

  // Nagłówek
  text(`Faktura VAT ${inv.number}`, M, 16, bold);
  const right = A4[0] - M;
  const meta = [`Data wystawienia: ${date(inv.issue_date)}${inv.place ? `, ${inv.place}` : ""}`, `Data sprzedaży: ${date(inv.sale_date)}`];
  meta.forEach((m, i) => page.drawText(m, { x: right - regular.widthOfTextAtSize(m, 9), y: y - i * 12 + 4, size: 9, font: regular }));
  y -= 40;

  const party = (title: string, p: Party, x: number) => {
    let yy = y;
    page.drawText(title, { x, y: yy, size: 8, font: bold, color: grey });
    yy -= 13;
    for (const l of [...fit(bold, p.name, 9.5, 240)]) {
      page.drawText(l, { x, y: yy, size: 9.5, font: bold });
      yy -= 12;
    }
    for (const l of [p.address1, p.address2, p.country && p.country !== "PL" ? p.country : null, p.nip ? `NIP: ${p.nip}` : null, p.email].filter(Boolean) as string[]) {
      page.drawText(l, { x, y: yy, size: 9, font: regular });
      yy -= 12;
    }
    return yy;
  };
  const y1 = party("SPRZEDAWCA", inv.seller, M);
  const y2 = party("NABYWCA", inv.buyer, A4[0] / 2 + 10);
  y = Math.min(y1, y2) - 14;

  // Tabela pozycji
  const cols = [M, M + 22, M + 270, M + 310, M + 355, M + 430];
  const head = ["Lp.", "Nazwa", "Ilość", "J.m.", "Cena brutto", "Wartość"];
  page.drawRectangle({ x: M - 4, y: y - 4, width: A4[0] - 2 * M + 8, height: 16, color: rgb(0.93, 0.94, 0.96) });
  head.forEach((h, i) => page.drawText(h, { x: cols[i], y: y + 1, size: 8, font: bold }));
  page.drawText("VAT", { x: right - 26, y: y + 1, size: 8, font: bold });
  y -= 18;
  for (const it of inv.items) {
    const nameLines = fit(regular, it.name, 9, 240);
    if (y - nameLines.length * 11 < 160) {
      page = doc.addPage(A4);
      y = A4[1] - M;
    }
    page.drawText(String(it.position), { x: cols[0], y, size: 9, font: regular });
    nameLines.forEach((l, i) => page.drawText(l, { x: cols[1], y: y - i * 11, size: 9, font: regular }));
    page.drawText(String(Number(it.quantity)), { x: cols[2], y, size: 9, font: regular });
    page.drawText(it.unit, { x: cols[3], y, size: 9, font: regular });
    page.drawText(pl(Number(it.unit_price_gross)), { x: cols[4], y, size: 9, font: regular });
    page.drawText(pl(Number(it.total_gross)), { x: cols[5], y, size: 9, font: regular });
    const vat = it.vat === "23" ? "23%" : "marża";
    page.drawText(vat, { x: right - 26, y, size: 9, font: regular });
    y -= Math.max(14, nameLines.length * 11 + 3);
  }
  page.drawLine({ start: { x: M - 4, y: y + 6 }, end: { x: right + 4, y: y + 6 }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) });
  y -= 10;

  // Podsumowanie
  const sumLines: [string, string][] = [];
  if (Number(inv.net_23) > 0) sumLines.push(["Wartość netto 23%", pl(Number(inv.net_23))], ["VAT 23%", pl(Number(inv.vat_23))]);
  if (Number(inv.margin_total) > 0) sumLines.push(["Sprzedaż w procedurze marży", pl(Number(inv.margin_total))]);
  sumLines.push([`Razem do zapłaty (${inv.currency})`, pl(Number(inv.total_gross))]);
  for (const [k, v] of sumLines) {
    const last = k.startsWith("Razem");
    const font = last ? bold : regular;
    const size = last ? 11 : 9;
    page.drawText(k, { x: right - 260, y, size, font });
    page.drawText(v, { x: right - font.widthOfTextAtSize(v, size), y, size, font });
    y -= last ? 18 : 13;
  }
  const payInfo = inv.paid
    ? `Zapłacono: ${PAY[inv.payment_method] ?? inv.payment_method}, ${date(inv.paid_at)}`
    : `Forma płatności: ${PAY[inv.payment_method] ?? inv.payment_method}${inv.due_date ? `, termin: ${date(inv.due_date)}` : ""}`;
  page.drawText(payInfo, { x: M, y, size: 9, font: regular });
  y -= 14;
  if (inv.seller.bank_account) {
    const acc = inv.seller.bank_account.replace(/\s/g, "").replace(/^(\d{2})(?=\d)/, "$1 ").replace(/(\d{4})(?=\d)/g, "$1 ").trim();
    page.drawText(`Numer konta: ${acc}`, { x: M, y, size: 9, font: bold });
    y -= 14;
  }
  if (Number(inv.margin_total) > 0) {
    page.drawText("procedura marży - towary używane", { x: M, y, size: 9, font: bold });
    y -= 14;
  }
  if (inv.notes) for (const l of fit(regular, inv.notes, 9, A4[0] - 2 * M)) {
    page.drawText(l, { x: M, y, size: 9, font: regular, color: grey });
    y -= 12;
  }

  // Kod QR KSeF (KOD I) – tylko dla faktur przesłanych do KSeF.
  if (inv.status !== "sending" && inv.status !== "accepted") {
    page.drawText(inv.status === "cancelled" ? "FAKTURA UNIEWAŻNIONA" : "Faktura nie została jeszcze przyjęta w KSeF – to nie jest dokument do przekazania nabywcy.", { x: M, y: 140, size: 9, font: bold, color: rgb(0.7, 0.1, 0.1) });
  } else if (inv.xml_hash && inv.seller.nip) {
    const link = verificationLink(inv.seller.nip, inv.issue_date, inv.xml_hash);
    const png = await QRCode.toBuffer(link, { errorCorrectionLevel: "M", margin: 1, width: 300 });
    const img = await doc.embedPng(png);
    const size = 96;
    const qy = Math.min(y - 10, 150) - size;
    page.drawImage(img, { x: M, y: qy, width: size, height: size });
    const label = inv.ksef_number ?? "OFFLINE";
    page.drawText(label, { x: M, y: qy - 11, size: 7.5, font: bold });
    page.drawText("Zweryfikuj fakturę w KSeF – zeskanuj kod QR", { x: M + size + 12, y: qy + size - 12, size: 8, font: regular, color: grey });
    fit(regular, link, 7, 330).forEach((l, i) => page.drawText(l, { x: M + size + 12, y: qy + size - 26 - i * 9, size: 7, font: regular, color: grey }));
  }
  return doc.save();
}
