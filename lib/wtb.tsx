import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";

const W = 1080;
const H = 1350;

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

/** Zdjęcie produktu jako data URL (PNG/JPEG – bez WebP, którego generator nie obsługuje). */
export async function imageData(url: string | null) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.hostname !== "cdn.shopify.com" && !u.hostname.endsWith(".shopify.com")) return null;
    u.searchParams.set("width", "1200");
    const res = await fetch(u, { headers: { Accept: "image/png,image/jpeg;q=0.9" }, cache: "no-store" });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !/image\/(png|jpe?g)/.test(type)) return null;
    return `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`;
  } catch {
    return null;
  }
}

/** Grafika „SNEAKERS DEPOT WTB”: zdjęcie produktu, rozmiar i SKU ze Shopify (PNG 1080×1350). */
export async function renderWtb(item: WtbItem, img: string | null, download: boolean) {
  const f = await fonts();
  const filename = `WTB ${item.title} ${item.size ?? ""}`.replace(/[^\p{L}\p{N} ._-]/gu, "").trim().slice(0, 80) || "WTB";
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "#ffffff", fontFamily: "DejaVu" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 28, height: 200, background: "#0b0b0b", color: "#ffffff" }}>
          <div style={{ fontSize: 60, fontWeight: 700, letterSpacing: 4 }}>SNEAKERS DEPOT</div>
          <div style={{ display: "flex", fontSize: 60, fontWeight: 700, letterSpacing: 4, background: "#ffffff", color: "#0b0b0b", padding: "4px 22px", borderRadius: 10 }}>WTB</div>
        </div>
        <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center", padding: "40px 70px" }}>
          {img ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={img} alt="" width={940} height={900} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
          ) : (
            <div style={{ display: "flex", fontSize: 36, color: "#9a9a9a" }}>brak zdjęcia</div>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", padding: "0 70px 64px" }}>
          <div style={{ display: "flex", fontSize: 38, fontWeight: 700, color: "#111111", lineHeight: 1.2, marginBottom: 28, maxHeight: 92, overflow: "hidden" }}>{item.title}</div>
          <div style={{ display: "flex", gap: 24 }}>
            <Box label="ROZMIAR" value={item.size ?? "–"} />
            <Box label="SKU" value={item.sku ?? "–"} grow />
          </div>
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
        ...(download ? { "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}.png` } : {}),
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
