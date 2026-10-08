/** Sprawdza podpis (PNG w data URL) przed użyciem: nagłówek, wymiary, rozmiar. Chroni przed „bombami” PNG. */
export function validateSignaturePng(dataUrl: string): string | null {
  const prefix = "data:image/png;base64,";
  if (!dataUrl.startsWith(prefix)) return "Złóż podpis w ramce.";
  if (dataUrl.length < 2000) return "Złóż podpis w ramce.";
  if (dataUrl.length > 600_000) return "Podpis jest za duży – wyczyść ramkę i podpisz się jeszcze raz.";
  let bytes: Buffer;
  try {
    bytes = Buffer.from(dataUrl.slice(prefix.length), "base64");
  } catch {
    return "Nieprawidłowy podpis.";
  }
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 33 || sig.some((b, i) => bytes[i] !== b) || bytes.toString("ascii", 12, 16) !== "IHDR") return "Nieprawidłowy podpis.";
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const bitDepth = bytes[24];
  if (width < 50 || height < 20 || width > 4000 || height > 1600 || width * height > 4_000_000 || bitDepth !== 8) return "Nieprawidłowy podpis.";
  return null;
}

export function escapeHtml(s: string | null | undefined) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
