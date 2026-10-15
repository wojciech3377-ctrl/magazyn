/**
 * Id zalogowanej osoby przekazywane z proxy do stron nagłówkiem – podpisane (HMAC kluczem serwera, ważne 2 min).
 * Bez podpisu nagłówek dało się podrobić na adresach, których proxy nie obsługuje (np. kończących się na .png),
 * i podszyć się pod innego pracownika. Brak klucza → bez nagłówka (strona sprawdza sesję sama).
 */
export const USER_HEADER = "x-magazyn-uid";

let keyPromise: Promise<CryptoKey> | null = null;
function key() {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) return null;
  keyPromise ??= crypto.subtle.importKey("raw", new TextEncoder().encode(`magazyn-uid:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return keyPromise;
}

async function sign(text: string) {
  const k = key();
  if (!k) return null;
  const sig = await crypto.subtle.sign("HMAC", await k, new TextEncoder().encode(text));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function signUserHeader(userId: string) {
  const ts = Date.now().toString(36);
  const sig = await sign(`${userId}.${ts}`);
  return sig ? `${userId}.${ts}.${sig}` : null;
}

export async function verifyUserHeader(value: string | null | undefined) {
  if (!value) return null;
  const [uid, ts, sig] = value.split(".");
  if (!uid || !ts || !sig || !/^[0-9a-f-]{36}$/i.test(uid)) return null;
  const age = Date.now() - parseInt(ts, 36);
  if (!(age >= -5_000 && age < 120_000)) return null;
  const expected = await sign(`${uid}.${ts}`);
  if (!expected || expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0 ? uid : null;
}
