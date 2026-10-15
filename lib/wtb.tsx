import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import { isWtbPhoto, wtbPhotoData } from "@/lib/wtb-photo";

/**
 * Grafika „SNEAKERS DEPOT WTB”: nagłówek i siatka butów, które chcemy kupić. Do 16 modeli 1080×1350 (Instagram),
 * więcej – szersza grafika (do 30 modeli na jednej: 1500×1650 albo 1800×1800).
 */

const HEADER = 190;
const PAD = 40;
export const WTB_PER_PAGE = 30;
const sheetSize = (n: number) => (n <= 16 ? { W: 1080, H: 1350 } : n <= 25 ? { W: 1500, H: 1650 } : { W: 1800, H: 1800 });

export type WtbItem = { title: string; size: string | null; sku: string | null; image: string | null; used?: boolean };

let fontCache: { regular: ArrayBuffer; bold: ArrayBuffer } | null = null;
const toArrayBuffer = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
async function fonts() {
  if (!fontCache) {
    const dir = path.join(process.cwd(), "lib/contracts/fonts");
    const [regular, bold] = await Promise.all([readFile(path.join(dir, "DejaVuSans.ttf")), readFile(path.join(dir, "DejaVuSans-Bold.ttf"))]);
    fontCache = { regular: toArrayBuffer(regular), bold: toArrayBuffer(bold) };
  }
  return fontCache;
}

/** Zdjęcie produktu jako data URL (PNG/JPEG – bez WebP, którego generator nie obsługuje). Z CDN Shopify albo własne zdjęcie WTB. */
export async function imageData(url: string | null, width = 1200) {
  if (!url) return null;
  if (isWtbPhoto(url)) return wtbPhotoData(url);
  try {
    const u = new URL(url);
    if (u.hostname !== "cdn.shopify.com" && !u.hostname.endsWith(".shopify.com")) return null;
    u.searchParams.set("width", String(width));
    const res = await fetch(u, { headers: { Accept: "image/png,image/jpeg;q=0.9" }, cache: "no-store", signal: AbortSignal.timeout(8000) });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !/image\/(png|jpe?g)/.test(type)) return null;
    return `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`;
  } catch {
    return null;
  }
}

/** Podział listy na strony po maks. 30 butów, możliwie równo (np. 40 → 20 + 20). */
export function wtbPages<T>(items: T[]): T[][] {
  if (!items.length) return [];
  const pages = Math.ceil(items.length / WTB_PER_PAGE);
  const per = Math.ceil(items.length / pages);
  return Array.from({ length: pages }, (_, i) => items.slice(i * per, (i + 1) * per));
}

function grid(n: number) {
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : n <= 16 ? 4 : n <= 25 ? 5 : 6;
  return { cols, rows: Math.ceil(n / cols) };
}

export async function renderWtbSheet(items: (WtbItem & { img: string | null })[], opts: { page: number; pages: number; download: boolean }) {
  const f = await fonts();
  const { cols, rows } = grid(items.length);
  const { W, H } = sheetSize(items.length);
  const gap = cols >= 3 ? 16 : 24;
  const cellW = Math.floor((W - PAD * 2 - gap * (cols - 1)) / cols);
  const cellH = Math.floor((H - HEADER - PAD * 2 - gap * (rows - 1)) / rows);
  const single = items.length === 1;
  // Ta sama wielkość liter na wszystkich kafelkach: rozmiary w najwyżej 2 liniach – czcionka dobrana do najdłuższej listy.
  const inner = cellW - (cols >= 3 ? 20 : 32);
  const maxSize = cols === 2 ? 36 : cols === 3 ? 28 : 22;
  const sizeLines = 3;
  const sizeFont = single ? 64 : uniformFont(items.map((it) => it.size ?? "–"), maxSize, inner, sizeLines);
  const skuFont = single ? 40 : cols === 2 ? 20 : cols === 3 ? 16 : 14;
  const titleFont = single ? 36 : cols === 2 ? 22 : cols === 3 ? 17 : 15;
  const footer = single ? 250 : titleFont * 2.5 + sizeFont * 1.15 * sizeLines + skuFont * 1.4 + 22;
  const filename = opts.pages > 1 ? `WTB-${opts.page}-z-${opts.pages}` : "WTB";

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "#ffffff", fontFamily: "DejaVu" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 26, height: HEADER, background: "#0b0b0b", color: "#ffffff", position: "relative" }}>
          <div style={{ fontSize: 60, fontWeight: 700, letterSpacing: 4 }}>SNEAKERS DEPOT</div>
          <div style={{ display: "flex", fontSize: 60, fontWeight: 700, letterSpacing: 4, background: "#ffffff", color: "#0b0b0b", padding: "4px 22px", borderRadius: 10 }}>WTB</div>
          {opts.pages > 1 && <div style={{ position: "absolute", right: 28, bottom: 16, fontSize: 22, color: "#9a9a9a" }}>{`${opts.page}/${opts.pages}`}</div>}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap, padding: PAD, flex: 1, alignContent: "center", justifyContent: "center" }}>
          {items.map((it, i) => (
            <div
              key={i}
              style={{
                display: "flex", flexDirection: "column", width: cellW, height: cellH,
                border: single ? "none" : "3px solid #e6e6e6", borderRadius: 18, padding: single ? 0 : cols >= 3 ? 10 : 16, overflow: "hidden",
              }}
            >
              <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center", minHeight: 0, position: "relative" }}>
                {it.img ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={it.img} alt="" width={cellW} height={Math.max(40, cellH - footer)} style={{ width: "100%", height: Math.max(40, cellH - footer), objectFit: "contain" }} />
                ) : (
                  <div style={{ display: "flex", fontSize: Math.max(16, skuFont), color: "#b0b0b0" }}>brak zdjęcia</div>
                )}
                {/* Znacznik USED / NEW – po zdjęciu, żeby leżał na nim (generator grafiki rysuje w kolejności). */}
                <div style={{
                  display: "flex", position: "absolute", top: single ? 12 : 4, left: single ? 12 : 4,
                  background: it.used ? "#0b0b0b" : "#ffffff", color: it.used ? "#ffffff" : "#0b0b0b", border: `${single ? 4 : 3}px solid #0b0b0b`,
                  fontSize: single ? 34 : cols >= 5 ? 14 : cols >= 3 ? 17 : 22, fontWeight: 700, letterSpacing: 2,
                  padding: single ? "4px 16px" : "2px 8px", borderRadius: 8,
                }}>{it.used ? "USED" : "NEW"}</div>
              </div>
              <div style={{ display: "flex", fontSize: titleFont, fontWeight: 700, color: "#111111", lineHeight: 1.2, height: single ? "auto" : titleFont * 2.45, maxHeight: titleFont * 2.45, overflow: "hidden", marginTop: 8 }}>{it.title}</div>
              {single ? (
                <div style={{ display: "flex", gap: 24, marginTop: 24 }}>
                  <Box label={it.size?.includes(" / ") ? "ROZMIARY" : "ROZMIAR"} value={it.size ?? "–"} />
                  <Box label="SKU" value={it.sku ?? "–"} grow />
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", marginTop: 6 }}>
                  <div style={{ display: "flex", fontSize: sizeFont, fontWeight: 700, color: "#0b0b0b", lineHeight: 1.15, height: sizeFont * 1.15 * sizeLines, overflow: "hidden", alignItems: "flex-start" }}>{it.size ? `${it.size}` : "–"}</div>
                  <div style={{ display: "flex", fontSize: skuFont, fontWeight: 700, color: "#6b6b6b", letterSpacing: 0.5, marginTop: 4, height: skuFont * 1.4, whiteSpace: "nowrap", overflow: "hidden" }}>{it.sku || " "}</div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    ),
    {
      width: W,
      height: H,
      fonts: [
        { name: "DejaVu", data: f.regular, weight: 400, style: "normal" },
        { name: "DejaVu", data: f.bold, weight: 700, style: "normal" },
      ],
      headers: {
        "Cache-Control": "private, no-store",
        ...(opts.download ? { "Content-Disposition": `attachment; filename="${filename}.png"` } : {}),
      },
    },
  );
}

/** Jedna wielkość czcionki dla wszystkich kafelków: najdłuższa lista rozmiarów mieści się w `lines` liniach (min. 13 px). */
function uniformFont(texts: string[], max: number, width: number, lines: number) {
  for (let size = max; size > 15; size--) {
    const perLine = Math.floor(width / (size * 0.62));
    const fits = texts.every((t) => {
      // zawijanie po przecinkach: liczymy linie jak przy łamaniu słów
      let used = 1, cur = 0;
      for (const w of t.split(" ")) {
        const len = w.length + (cur ? 1 : 0);
        if (cur + len > perLine) { used++; cur = w.length; } else cur += len;
      }
      return used <= lines;
    });
    if (fits) return size;
  }
  return 15;
}

function Box({ label, value, grow }: { label: string; value: string; grow?: boolean }) {
  const size = value.length > 30 ? 30 : value.length > 18 ? 40 : value.length > 12 ? 48 : 60;
  return (
    <div style={{ display: "flex", flexDirection: "column", flexGrow: grow ? 1 : 0, minWidth: 260, border: "4px solid #0b0b0b", borderRadius: 18, padding: "18px 28px" }}>
      <div style={{ display: "flex", fontSize: 26, fontWeight: 700, color: "#6b6b6b", letterSpacing: 3 }}>{label}</div>
      <div style={{ display: "flex", fontSize: size, fontWeight: 700, color: "#0b0b0b" }}>{value}</div>
    </div>
  );
}
