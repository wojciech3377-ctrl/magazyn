import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";

/** Grafika „SNEAKERS DEPOT WTB” (1080×1350): nagłówek i siatka butów, które chcemy kupić. */

const W = 1080;
const H = 1350;
const HEADER = 190;
const PAD = 40;
export const WTB_PER_PAGE = 16;

export type WtbItem = { title: string; size: string | null; sku: string | null; image: string | null };

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

/** Zdjęcie produktu jako data URL (PNG/JPEG – bez WebP, którego generator nie obsługuje). Tylko z CDN Shopify. */
export async function imageData(url: string | null, width = 1200) {
  if (!url) return null;
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

/** Podział listy na strony po maks. 16 butów, możliwie równo (np. 20 → 10 + 10). */
export function wtbPages<T>(items: T[]): T[][] {
  if (!items.length) return [];
  const pages = Math.ceil(items.length / WTB_PER_PAGE);
  const per = Math.ceil(items.length / pages);
  return Array.from({ length: pages }, (_, i) => items.slice(i * per, (i + 1) * per));
}

function grid(n: number) {
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
  return { cols, rows: Math.ceil(n / cols) };
}

export async function renderWtbSheet(items: (WtbItem & { img: string | null })[], opts: { page: number; pages: number; download: boolean }) {
  const f = await fonts();
  const { cols, rows } = grid(items.length);
  const gap = cols >= 3 ? 16 : 24;
  const cellW = Math.floor((W - PAD * 2 - gap * (cols - 1)) / cols);
  const cellH = Math.floor((H - HEADER - PAD * 2 - gap * (rows - 1)) / rows);
  const single = items.length === 1;
  const sizeFont = single ? 64 : cols === 2 ? 42 : cols === 3 ? 34 : 28;
  const skuFont = single ? 40 : cols === 2 ? 24 : cols === 3 ? 20 : 17;
  const titleFont = single ? 36 : cols === 2 ? 22 : 0;
  const footer = single ? 250 : titleFont ? sizeFont + skuFont + titleFont * 2.5 + 36 : sizeFont + skuFont + 26;
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
              <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center", minHeight: 0 }}>
                {it.img ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={it.img} alt="" width={cellW} height={Math.max(40, cellH - footer)} style={{ width: "100%", height: Math.max(40, cellH - footer), objectFit: "contain" }} />
                ) : (
                  <div style={{ display: "flex", fontSize: Math.max(16, skuFont), color: "#b0b0b0" }}>brak zdjęcia</div>
                )}
              </div>
              {titleFont > 0 && (
                <div style={{ display: "flex", fontSize: titleFont, fontWeight: 700, color: "#111111", lineHeight: 1.2, maxHeight: titleFont * 2.45, overflow: "hidden", marginTop: 8 }}>{it.title}</div>
              )}
              {single ? (
                <div style={{ display: "flex", gap: 24, marginTop: 24 }}>
                  <Box label="ROZMIAR" value={it.size ?? "–"} />
                  <Box label="SKU" value={it.sku ?? "–"} grow />
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", marginTop: 6 }}>
                  <div style={{ display: "flex", fontSize: sizeFont, fontWeight: 700, color: "#0b0b0b", lineHeight: 1.1 }}>{it.size ? `${it.size}` : "–"}</div>
                  <div style={{ display: "flex", fontSize: skuFont, fontWeight: 700, color: "#6b6b6b", letterSpacing: 1, marginTop: 4, whiteSpace: "nowrap", overflow: "hidden" }}>{it.sku ?? ""}</div>
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

function Box({ label, value, grow }: { label: string; value: string; grow?: boolean }) {
  const size = value.length > 18 ? 40 : value.length > 12 ? 48 : 60;
  return (
    <div style={{ display: "flex", flexDirection: "column", flexGrow: grow ? 1 : 0, minWidth: 260, border: "4px solid #0b0b0b", borderRadius: 18, padding: "18px 28px" }}>
      <div style={{ display: "flex", fontSize: 26, fontWeight: 700, color: "#6b6b6b", letterSpacing: 3 }}>{label}</div>
      <div style={{ display: "flex", fontSize: size, fontWeight: 700, color: "#0b0b0b" }}>{value}</div>
    </div>
  );
}
