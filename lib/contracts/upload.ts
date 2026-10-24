import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

const PATH_RE = /^\d{4}\/\d{2}\/[0-9a-f-]{36}\.[a-z0-9]{1,5}$/;

/**
 * Podpis ścieżki wgrywanego pliku: serwer wydaje ścieżkę razem z podpisem i przyjmuje tylko tę ścieżkę.
 * Bez tego dało się podać w formularzu ścieżkę cudzego pliku (np. innej umowy) i go przypiąć albo usunąć.
 * `scope` wiąże ścieżkę z umową / komisantem (link do podpisu, panel komisanta).
 */
function pathSig(path: string, scope: string) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("Brak klucza serwera.");
  return createHmac("sha256", `upload:${key}`).update(`${scope}|${path}`).digest("hex");
}
export function signUploadPath(path: string, scope = "staff") {
  return pathSig(path, scope);
}
export function verifyUploadPath(path: string, sig: unknown, scope = "staff") {
  if (typeof sig !== "string" || !/^[0-9a-f]{64}$/.test(sig) || !PATH_RE.test(path)) return false;
  return timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(pathSig(path, scope), "hex"));
}

/** Plik umowy wgrany już z przeglądarki do bucketu „contracts”; tu sprawdzamy ścieżkę i podpis serwera. */
export function uploadedFile(formData: FormData, scope = "staff") {
  const path = String(formData.get("file_path") ?? "").trim();
  if (!path) return null;
  if (!PATH_RE.test(path)) throw new Error("Nieprawidłowa ścieżka pliku umowy.");
  if (!verifyUploadPath(path, formData.get("file_sig"), scope)) throw new Error("Plik nie pochodzi z tego formularza – wgraj go ponownie.");
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
