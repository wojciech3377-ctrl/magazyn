import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import type { Block, Run } from "./purchase";

const A4: [number, number] = [595.28, 841.89];
const MARGIN_X = 50;
const MARGIN_TOP = 40;
const MARGIN_BOTTOM = 36;
const SIZE = 8.8;
const LEADING = 11.8;

let fontCache: { regular: Uint8Array; bold: Uint8Array } | null = null;
async function fonts() {
  if (!fontCache) {
    const dir = path.join(process.cwd(), "lib/contracts/fonts");
    const [regular, bold] = await Promise.all([readFile(path.join(dir, "DejaVuSans.ttf")), readFile(path.join(dir, "DejaVuSans-Bold.ttf"))]);
    fontCache = { regular, bold };
  }
  return fontCache;
}

function dataUrlToBytes(dataUrl: string) {
  const b64 = dataUrl.split(",")[1] ?? "";
  return Uint8Array.from(Buffer.from(b64, "base64"));
}

type Word = { text: string; font: PDFFont; width: number };

/** PDF umowy z bloków treści; podpisy jako obrazki PNG (data URL), opcjonalne. */
export async function renderContractPdf(
  blocks: Block[],
  opts: { buyerSignature?: string | null; sellerSignature?: string | null; title: string; signedNote?: string | null },
) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const f = await fonts();
  const regular = await doc.embedFont(f.regular, { subset: true });
  const bold = await doc.embedFont(f.bold, { subset: true });
  doc.setTitle(opts.title);
  doc.setLanguage("pl-PL");

  const maxWidth = A4[0] - MARGIN_X * 2;
  let page: PDFPage = doc.addPage(A4);
  let y = A4[1] - MARGIN_TOP;

  const ensure = (h: number) => {
    if (y - h < MARGIN_BOTTOM) {
      page = doc.addPage(A4);
      y = A4[1] - MARGIN_TOP;
    }
  };

  const wrapRuns = (runs: Run[], size: number) => {
    const words: Word[] = [];
    for (const r of runs) {
      const font = r.bold ? bold : regular;
      for (const w of r.text.split(/(\s+)/).filter((x) => x.length)) {
        words.push({ text: w, font, width: font.widthOfTextAtSize(w, size) });
      }
    }
    const lines: Word[][] = [];
    let line: Word[] = [];
    let width = 0;
    for (const w of words) {
      const isSpace = /^\s+$/.test(w.text);
      if (isSpace && line.length === 0) continue;
      if (!isSpace && width + w.width > maxWidth && line.length) {
        while (line.length && /^\s+$/.test(line[line.length - 1].text)) line.pop();
        lines.push(line);
        line = [];
        width = 0;
      }
      line.push(w);
      width += w.width;
    }
    if (line.length) lines.push(line);
    return lines;
  };

  const drawLines = (lines: Word[][], size: number, leading: number, align: "left" | "center" = "left", color = rgb(0, 0, 0)) => {
    for (const l of lines) {
      ensure(leading);
      const w = l.reduce((s, x) => s + x.width, 0);
      let x = align === "center" ? (A4[0] - w) / 2 : MARGIN_X;
      for (const word of l) {
        if (!/^\s+$/.test(word.text)) page.drawText(word.text, { x, y: y - size, size, font: word.font, color });
        x += word.width;
      }
      y -= leading;
    }
  };

  for (const block of blocks) {
    switch (block.kind) {
      case "date": {
        for (const [text, s] of [[block.text, SIZE], [block.note, SIZE]] as const) {
          const w = regular.widthOfTextAtSize(text, s);
          page.drawText(text, { x: A4[0] - MARGIN_X - w, y: y - s, size: s, font: regular });
          y -= LEADING;
        }
        y -= 18;
        break;
      }
      case "title":
        drawLines(wrapRuns([{ text: block.text, bold: true }], 12.5), 12.5, 18, "center");
        y -= 12;
        break;
      case "section":
        y -= 10;
        drawLines(wrapRuns([{ text: block.text, bold: true }], SIZE), SIZE, LEADING, "center");
        y -= 8;
        break;
      case "p":
        y -= block.gap ?? 0;
        drawLines(wrapRuns(block.runs, SIZE), SIZE, LEADING);
        break;
      case "signatures": {
        ensure(105);
        y -= 20;
        const boxW = 170, boxH = 60;
        const leftX = MARGIN_X + 20, rightX = A4[0] - MARGIN_X - boxW - 20;
        for (const [sig, x, label] of [
          [opts.buyerSignature, leftX, "Kupujący"],
          [opts.sellerSignature, rightX, "Sprzedający"],
        ] as const) {
          if (sig) {
            const img = await doc.embedPng(dataUrlToBytes(sig));
            const scale = Math.min(boxW / img.width, boxH / img.height);
            page.drawImage(img, { x: x + (boxW - img.width * scale) / 2, y: y - boxH, width: img.width * scale, height: img.height * scale });
          }
          page.drawLine({ start: { x, y: y - boxH - 4 }, end: { x: x + boxW, y: y - boxH - 4 }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) });
          const lw = bold.widthOfTextAtSize(label, SIZE);
          page.drawText(label, { x: x + (boxW - lw) / 2, y: y - boxH - 18, size: SIZE, font: bold });
        }
        y -= boxH + 30;
        if (opts.signedNote) {
          drawLines(wrapRuns([{ text: opts.signedNote }], 7), 7, 9, "left", rgb(0.35, 0.35, 0.35));
          y -= 6;
        }
        break;
      }
      case "footer":
        y -= 6;
        drawLines(wrapRuns([{ text: block.text }], 6.5), 6.5, 8.5, "left", rgb(0.25, 0.25, 0.25));
        break;
    }
  }

  return doc.save();
}
