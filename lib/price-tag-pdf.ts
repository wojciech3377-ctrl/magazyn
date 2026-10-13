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
// Odstęp od górnej krawędzi: drukarki etykiet potrafią przesunąć wydruk o ~1 mm i ucinały pasek sklepu.
const TOP = 1.3 * MM;

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

/** Tekst z odstępami między literami (pdf-lib nie ma letter-spacing). Zwraca szerokość. */
function spaced(page: PDFPage | null, text: string, x: number, y: number, size: number, font: PDFFont, gap: number, color = rgb(0, 0, 0)) {
  let cx = x;
  for (const ch of text) {
    page?.drawText(ch, { x: cx, y, size, font, color });
    cx += font.widthOfTextAtSize(ch, size) + gap;
  }
  return cx - x - gap;
}

/** Prostokąt z zaokrąglonymi rogami (x, y = lewy dolny róg). */
function roundRect(page: PDFPage, x: number, y: number, w: number, h: number, r: number, opts: { fill?: boolean; border?: number }) {
  const d = `M ${r} 0 H ${w - r} A ${r} ${r} 0 0 1 ${w} ${r} V ${h - r} A ${r} ${r} 0 0 1 ${w - r} ${h} H ${r} A ${r} ${r} 0 0 1 0 ${h - r} V ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`;
  // Ścieżka SVG ma oś Y w dół – rysujemy od lewego górnego rogu.
  page.drawSvgPath(d, {
    x, y: y + h,
    color: opts.fill ? rgb(0, 0, 0) : undefined,
    borderColor: opts.border ? rgb(0, 0, 0) : undefined,
    borderWidth: opts.border ?? 0,
  });
}

/**
 * Metka 57 × 32 mm: czarny pasek z nazwą sklepu (Sneakers Depot / Telefoniki), nazwa produktu, cena z ramką rozmiaru
 * (metka produktu – bez rozmiaru, z napisem „Zeskanuj – dostępne rozmiary”),
 * informacja Omnibus, IMEI telefonu (gdy jest) i kod kreskowy sztuki z numerem pod spodem.
 */
export async function renderPriceTags(tags: PriceTag[]) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const f = await fonts();
  const regular = await doc.embedFont(f.regular, { subset: true });
  const bold = await doc.embedFont(f.bold, { subset: true });
  doc.setTitle("Metki sklepowe");
  const inner = W - 2 * PAD_X;
  const white = rgb(1, 1, 1);

  for (const t of tags) {
    const page = doc.addPage([W, H]);

    // Pasek sklepu (pełna szerokość, odwrócone kolory).
    const band = 3.7 * MM;
    const bandY = H - TOP - band;
    page.drawRectangle({ x: 0, y: bandY, width: W, height: band, color: rgb(0, 0, 0) });
    const store = (t.storeName || "Sklep").toUpperCase();
    let ss = 6.2;
    while (ss > 4.5 && spaced(null, store, 0, 0, ss, bold, ss * 0.16) > inner) ss -= 0.2;
    spaced(page, store, PAD_X, bandY + (band - ss * 0.72) / 2, ss, bold, ss * 0.16, white);

    // Nazwa produktu (do 2 linii).
    let y = bandY - 1.0;
    for (const line of wrap(bold, t.title, 7, inner, 2)) {
      y -= 7.4;
      page.drawText(line, { x: PAD_X, y, size: 7, font: bold });
    }

    // Metka sztuki (Magazyn): bez cen – duża ramka z rozmiarem / wariantem, IMEI obok, kod kreskowy.
    if (!t.productTag) {
      const val = t.option || "–";
      const vs = fitSize(bold, val, 13, 26 * MM, 7);
      const bw = Math.max(13 * MM, bold.widthOfTextAtSize(val, vs) + 4 * MM);
      const bh = 8.4 * MM;
      y -= 1.4;
      const by = y - bh;
      roundRect(page, PAD_X, by, bw, bh, 1.6 * MM / 1.2, { border: 0.8 });
      const lab = /^\d{1,2}([.,]\d|\s?\d\/\d)?$/.test(val.trim()) ? "ROZMIAR" : "WARIANT";
      const lw = spaced(null, lab, 0, 0, 3.9, regular, 0.35);
      spaced(page, lab, PAD_X + (bw - lw) / 2, by + bh - 5.6, 3.9, regular, 0.35);
      page.drawText(val, { x: PAD_X + (bw - bold.widthOfTextAtSize(val, vs)) / 2, y: by + 2.6, size: vs, font: bold });
      const imei = (t.identifier ?? "").trim();
      if (imei) {
        const label = /^\d{15}$/.test(imei) ? "IMEI" : "S/N";
        const ix = PAD_X + bw + 2 * MM;
        const iw = W - PAD_X - ix;
        const isz = fitSize(bold, imei, 7, iw, 4.4);
        page.drawText(label, { x: ix, y: by + bh / 2 + 1.2, size: 4.6, font: regular });
        page.drawText(imei, { x: ix, y: by + bh / 2 - isz - 0.2, size: isz, font: bold });
      }
      const codeSize = 5.6;
      const codeW = spaced(null, t.sku, 0, 0, codeSize, regular, 0.9);
      spaced(page, t.sku, (W - codeW) / 2, PAD_Y - 0.4, codeSize, regular, 0.9);
      const barBottom = PAD_Y + codeSize + 0.6;
      barcode(page, t.sku, QUIET, barBottom, W - 2 * QUIET, Math.max(9, Math.min(22, by - 2.2 - barBottom)));
      continue;
    }

    // Metka sklepowa (produkt): cena od najtańszego do najdroższego rozmiaru, cena przed obniżką, Omnibus – bez rozmiaru.
    const withBox = false;
    const sizeVal = t.option || "–";
    const sv = fitSize(bold, sizeVal, 9.5, 18 * MM, 6);
    const boxW = withBox ? Math.max(9.5 * MM, bold.widthOfTextAtSize(sizeVal, sv) + 3.2 * MM) : 0;
    const boxH = 7.4 * MM;
    const priceW = withBox ? inner - boxW - 1.6 * MM : inner;
    y -= 1.6;
    const blockTop = y;
    if (t.promo && t.compareAt) {
      const label = "Przed obniżką ";
      const old = fmtRange(t.compareAt);
      const ls = fitSize(regular, label + old, 5.4, priceW, 4.2);
      y -= ls + 0.6;
      page.drawText(label, { x: PAD_X, y, size: ls, font: regular });
      const ox = PAD_X + regular.widthOfTextAtSize(label, ls);
      page.drawText(old, { x: ox, y, size: ls, font: regular });
      page.drawLine({ start: { x: ox - 0.3, y: y + ls * 0.33 }, end: { x: ox + regular.widthOfTextAtSize(old, ls) + 0.3, y: y + ls * 0.33 }, thickness: 0.6 });
    }
    const price = fmtRange(t.price);
    const ps = fitSize(bold, price, t.promo ? 12.5 : 14, priceW, 7);
    y -= ps * 0.78 + 1.4;
    page.drawText(price, { x: PAD_X, y, size: ps, font: bold });
    if (t.promo) {
      // Podkreślenie ceny promocyjnej.
      page.drawRectangle({ x: PAD_X, y: y - 1.6, width: Math.min(priceW, bold.widthOfTextAtSize(price, ps)), height: 0.7, color: rgb(0, 0, 0) });
    }
    if (withBox) {
      const boxX = W - PAD_X - boxW;
      const boxY = Math.min(blockTop - boxH, y - 1.6);
      roundRect(page, boxX, boxY, boxW, boxH, 1.6 * MM / 1.2, { border: 0.8 });
      // Buty: rozmiar (42, 44.5, 44 2/3); telefony i reszta: wariant (128GB, Midnight).
      const lab = /^\d{1,2}([.,]\d|\s?\d\/\d)?$/.test(sizeVal.trim()) ? "ROZMIAR" : "WARIANT";
      const labW = spaced(null, lab, 0, 0, 3.7, regular, 0.35);
      spaced(page, lab, boxX + (boxW - labW) / 2, boxY + boxH - 5.4, 3.7, regular, 0.35);
      page.drawText(sizeVal, { x: boxX + (boxW - bold.widthOfTextAtSize(sizeVal, sv)) / 2, y: boxY + 2.9, size: sv, font: bold });
      y = Math.min(y - 1.6, boxY);
    } else y -= 1.6;

    // Najniższa cena z 30 dni (Omnibus).
    const low = `Najniższa cena z 30 dni${t.promo ? " przed obniżką" : ""}: ${fmtRange(t.lowest30)}`;
    const lsz = fitSize(regular, low, 5.2, inner, 4.2);
    y -= lsz + 1.3;
    page.drawText(low, { x: PAD_X, y, size: lsz, font: regular });

    // IMEI telefonu (Telefoniki) – numer sztuki zapisany przy przyjęciu.
    const imei = (t.identifier ?? "").trim();
    if (imei) {
      const label = /^\d{15}$/.test(imei) ? "IMEI " : "S/N ";
      const isz = fitSize(bold, label + imei, 6.4, inner, 4.6);
      y -= isz + 1.6;
      page.drawText(label, { x: PAD_X, y, size: isz, font: regular });
      page.drawText(imei, { x: PAD_X + regular.widthOfTextAtSize(label, isz), y, size: isz, font: bold });
    }

    // Dół: kod kreskowy sztuki i jego numer pod spodem.
    const codeSize = 5.6;
    const codeW = spaced(null, t.sku, 0, 0, codeSize, regular, 0.9);
    spaced(page, t.sku, (W - codeW) / 2, PAD_Y - 0.4, codeSize, regular, 0.9);
    const barBottom = PAD_Y + codeSize + 0.6;
    const barH = Math.max(9, Math.min(18, y - 2.2 - barBottom));
    barcode(page, t.sku, QUIET, barBottom, W - 2 * QUIET, barH);
  }
  return doc.save();
}
