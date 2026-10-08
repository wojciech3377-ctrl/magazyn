import "server-only";

const PATH_RE = /^\d{4}\/\d{2}\/[0-9a-f-]{36}\.[a-z0-9]{1,5}$/;

/** Plik umowy wgrany już z przeglądarki do bucketu „contracts”; tu tylko sprawdzamy ścieżkę. */
export function uploadedFile(formData: FormData) {
  const path = String(formData.get("file_path") ?? "").trim();
  if (!path) return null;
  if (!PATH_RE.test(path)) throw new Error("Nieprawidłowa ścieżka pliku umowy.");
  const name = String(formData.get("file_name") ?? "").trim().slice(0, 200) || path.split("/").pop()!;
  return { path, name };
}

export function parseAmount(v: FormDataEntryValue | null) {
  const s = String(v ?? "").replace(/\s/g, "").replace(",", ".");
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Nieprawidłowa kwota: ${v}`);
  return Math.round(n * 100) / 100;
}
