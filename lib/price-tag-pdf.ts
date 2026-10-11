import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import JsBarcode from "jsbarcode";
import { fmtRange, type PriceTag } from "./price-tag";

/** Metki sklepowe jako PDF: każda strona dokładnie 57 × 32 mm (do drukarki etykiet, bez marginesów i pustych stron). */
const MM = 72 / 25.4;
const W = 57 * MM;
const H = 32 * MM;
const PAD_X = 2.2 * MM;
const PAD_Y = 1.6 * MM;
const QUIET = 3 * MM; // pusty margines po bokach kodu kreskowego (czytelność skanera)

let fontCache: { regular: Uint8Array; bold: Uint8Array } | null = null;
async function fonts() {
  if (!fontCache) {
    const dir = path.join(process.cwd(), "lib/contracts/fonts");
    const [regular, bold] = await Promise.all([readFile(path.join(dir, "DejaVuSans.ttf")), readFile(path.join(dir, "DejaVuSans-Bold.ttf"))]);
    fontCache = { regular, bold };
  }
  return fontCache;
}

function wrap(font: PDFFont, text: string, size: number, width: number, maxLines: number) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) <= width) cur = next;
    else { if (cur) lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (last && font.widthOfTextAtSize(`${last}…`, size) > width) last = last.slice(0, -1);
    kept[maxLines - 1] = `${last.trimEnd()}…`;
    return kept;
  }
  return lines;
}

/** Największa czcionka (od `max` w dół), przy której tekst mieści się w szerokości. */
const fitSize = (font: PDFFont, text: string, max: number, width: number, min = 6) => {
  let s = max;
  while (s > min && font.widthOfTextAtSize(text, s) > width) s -= 0.25;
  return s;
};

function barcode(page: PDFPage, value: string, x: number, y: number, width: number, height: number) {
  const data: { encodings?: { data: string }[] } = {};
  JsBarcode(data, value, { format: "CODE128" });
  const bits = (data.encodings ?? []).map((e) => e.data).join("");
  if (!bits) return;
  const m = width / bits.length;
  let i = 0;
  while (i < bits.length) {
    if (bits[i] === "1") {
      let j = i;
      while (j < bits.length && bits[j] === "1") j++;
      page.drawRectangle({ x: x + i * m, y, width: (j - i) * m, height, color: rgb(0, 0, 0) });
      i = j;
    } else i++;
  }
}

export async function renderPriceTags(tags: PriceTag[]) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const f = await fonts();
  const regular = await doc.embedFont(f.regular, { subset: true });
  const bold = await doc.embedFont(f.bold, { subset: true });
  doc.setTitle("Metki sklepowe");
  const inner = W - 2 * PAD_X;

  for (const t of tags) {
    const page = doc.addPage([W, H]);
    let y = H - PAD_Y;
    // Nazwa (do 2 linii).
    for (const line of wrap(bold, t.title, 7.5, inner, 2)) {
      y -= 7.8;
      page.drawText(line, { x: PAD_X, y, size: 7.5, font: bold });
    }
    // Promocja: cena przed obniżką (przekreślona).
    if (t.promo && t.compareAt) {
      const label = "Cena przed obniżką: ";
      const old = fmtRange(t.compareAt);
      y -= 7.2;
      page.drawText(label, { x: PAD_X, y, size: 6, font: regular });
      const ox = PAD_X + regular.widthOfTextAtSize(label, 6);
      page.drawText(old, { x: ox, y, size: 6, font: regular });
      page.drawLine({ start: { x: ox, y: y + 2.1 }, end: { x: ox + regular.widthOfTextAtSize(old, 6), y: y + 2.1 }, thickness: 0.6 });
    }
    // Cena (zakres po rozmiarach).
    const price = `${t.promo ? "Teraz: " : ""}${fmtRange(t.price)}`;
    const ps = fitSize(bold, price, t.promo ? 11.5 : 13, inner);
    y -= ps + 1;
    page.drawText(price, { x: PAD_X, y, size: ps, font: bold });
    // Najniższa cena z 30 dni.
    const low = `Najniższa cena z 30 dni${t.promo ? " przed obniżką" : ""}: ${fmtRange(t.lowest30)}`;
    const ls = fitSize(regular, low, 5.6, inner, 4.5);
    y -= ls + 1.6;
    page.drawText(low, { x: PAD_X, y, size: ls, font: regular });

    // Dół: kod kreskowy i SKU + rozmiar.
    const skuY = PAD_Y;
    const skuText = `SKU: ${t.sku}`;
    const size = `Rozm. ${t.option}`;
    page.drawText(skuText, { x: PAD_X, y: skuY, size: 6.3, font: regular });
    page.drawText(size, { x: W - PAD_X - bold.widthOfTextAtSize(size, 6.8), y: skuY, size: 6.8, font: bold });
    const barTop = y - 1.5;
    const barBottom = skuY + 7.2;
    const barH = Math.max(10, Math.min(19, barTop - barBottom));
    barcode(page, t.sku, QUIET, barBottom, W - 2 * QUIET, barH);
  }
  return doc.save();
}
