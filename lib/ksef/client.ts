import "server-only";
import { X509Certificate, constants, createCipheriv, createHash, publicEncrypt, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * KSeF 2.0 (api.ksef.mf.gov.pl/v2): logowanie tokenem KSeF, sesja interaktywna, wysyłka faktury FA(3),
 * status i numer KSeF. Token KSeF i NIP tylko w zmiennych środowiskowych (KSEF_TOKEN, KSEF_NIP).
 * Tokeny dostępowe (accessToken ~15 min, refreshToken do 7 dni) w integration_tokens (tylko serwer).
 */

const PROVIDER = "ksef";
const ENVS = {
  prod: { api: "https://api.ksef.mf.gov.pl/v2", qr: "https://qr.ksef.mf.gov.pl" },
  demo: { api: "https://api-demo.ksef.mf.gov.pl/v2", qr: "https://qr-demo.ksef.mf.gov.pl" },
  test: { api: "https://api-test.ksef.mf.gov.pl/v2", qr: "https://qr-test.ksef.mf.gov.pl" },
} as const;

export function ksefEnv() {
  const e = (process.env.KSEF_ENV ?? "prod").toLowerCase();
  return e === "test" || e === "demo" ? e : "prod";
}
const base = () => ENVS[ksefEnv()].api;
export const ksefQrBase = () => ENVS[ksefEnv()].qr;

export function ksefConfigured() {
  return !!process.env.KSEF_TOKEN && !!process.env.KSEF_NIP;
}

export class KsefError extends Error {
  constructor(public status: number, message: string, public code?: number) {
    super(`KSeF: ${message}`);
  }
}

async function readError(res: Response) {
  const text = await res.text();
  try {
    const b = JSON.parse(text) as {
      exception?: { exceptionDetailList?: { exceptionCode?: number; exceptionDescription?: string; details?: string[] }[] };
      title?: string; detail?: string; errors?: unknown;
    };
    const d = b.exception?.exceptionDetailList?.[0];
    if (d) return { code: d.exceptionCode, message: [d.exceptionDescription, ...(d.details ?? [])].filter(Boolean).join(" – ") };
    if (Array.isArray(b.errors) && b.errors.length) {
      const e = b.errors[0] as { code?: number; description?: string; details?: string[] };
      return { code: e.code, message: (b.errors as { description?: string; details?: string[] }[]).map((x) => [x.description, ...(x.details ?? [])].filter(Boolean).join(" – ")).join("; ") };
    }
    if (b.errors && typeof b.errors === "object") {
      return { code: undefined, message: Object.entries(b.errors as Record<string, string[]>).map(([k, v]) => `${k}: ${[].concat(v as never).join(", ")}`).join("; ") };
    }
    return { code: undefined, message: b.detail ?? b.title ?? `błąd ${res.status}` };
  } catch {
    return { code: undefined, message: `błąd ${res.status}: ${text.replace(/\s+/g, " ").slice(0, 200)}` };
  }
}

async function call<T>(path: string, init: { method?: string; body?: unknown; bearer?: string } = {}): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${base()}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Accept: "application/json",
        "X-Error-Format": "problem-details",
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(init.bearer ? { Authorization: `Bearer ${init.bearer}` } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
    });
    if (res.status === 429) {
      const raw = res.headers.get("retry-after");
      const secs = raw ? (Number.isFinite(Number(raw)) ? Number(raw) : (Date.parse(raw) - Date.now()) / 1000) : 5;
      if (secs > 20) throw new KsefError(429, `KSeF ogranicza liczbę zapytań – spróbuj za ${Math.ceil(secs)} s`);
      await new Promise((r) => setTimeout(r, Math.max(1, Number.isFinite(secs) ? secs : 5) * 1000));
      continue;
    }
    if (!res.ok) {
      const e = await readError(res);
      throw new KsefError(res.status, e.message, e.code);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }
  throw new KsefError(429, "przekroczony limit zapytań, spróbuj za chwilę");
}

type Cert = { certificate: string; publicKeyId?: string; validFrom: string; validTo: string; usage: string[] };
let certCache: { at: number; certs: Cert[] } | null = null;

async function certFor(usage: "KsefTokenEncryption" | "SymmetricKeyEncryption", refresh = false) {
  if (refresh || !certCache || Date.now() - certCache.at > 3600_000) {
    certCache = { at: Date.now(), certs: await call<Cert[]>("/security/public-key-certificates") };
  }
  const now = Date.now();
  const c = certCache.certs
    .filter((x) => x.usage.includes(usage) && Date.parse(x.validFrom) <= now && now < Date.parse(x.validTo))
    .sort((a, b) => Date.parse(b.validFrom) - Date.parse(a.validFrom))[0];
  if (!c) throw new KsefError(0, `brak klucza publicznego MF (${usage})`);
  return c;
}

function rsaOaep(certB64: string, data: Buffer) {
  const key = new X509Certificate(Buffer.from(certB64, "base64")).publicKey;
  return publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, data).toString("base64");
}

const sha256b64 = (b: Buffer) => createHash("sha256").update(b).digest("base64");

type TokenPair = { accessToken: { token: string; validUntil: string }; refreshToken?: { token: string; validUntil: string } };

/** Nieznany / wycofany klucz MF (21470): pobranie kluczy na nowo i jedno ponowienie. */
async function withFreshKeys<T>(fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof KsefError && e.code === 21470) {
      certCache = null;
      return fn();
    }
    throw e;
  }
}

/** Pełne logowanie tokenem KSeF: challenge → zaszyfrowany token → status → tokeny dostępowe. */
async function authenticate(db: SupabaseClient) {
  return withFreshKeys(() => authenticateOnce(db));
}

async function authenticateOnce(db: SupabaseClient) {
  const token = process.env.KSEF_TOKEN;
  const nip = (process.env.KSEF_NIP ?? "").replace(/\D/g, "");
  if (!token || !nip) throw new KsefError(0, "brak KSEF_TOKEN / KSEF_NIP w ustawieniach serwera");
  const ch = await call<{ challenge: string; timestampMs: number }>("/auth/challenge", { method: "POST" });
  const cert = await certFor("KsefTokenEncryption");
  const init = await call<{ referenceNumber: string; authenticationToken: { token: string } }>("/auth/ksef-token", {
    method: "POST",
    body: {
      challenge: ch.challenge,
      contextIdentifier: { type: "Nip", value: nip },
      encryptedToken: rsaOaep(cert.certificate, Buffer.from(`${token}|${ch.timestampMs}`, "utf8")),
      ...(cert.publicKeyId ? { publicKeyId: cert.publicKeyId } : {}),
    },
  });
  const authToken = init.authenticationToken.token;
  for (let i = 0; i < 20; i++) {
    const st = await call<{ status: { code: number; description?: string; details?: string[] } }>(`/auth/${init.referenceNumber}`, { bearer: authToken });
    if (st.status.code === 200) break;
    if (st.status.code !== 100) throw new KsefError(403, `logowanie odrzucone (${st.status.code}): ${[st.status.description, ...(st.status.details ?? [])].filter(Boolean).join(" – ")}`, st.status.code);
    if (i === 19) throw new KsefError(504, "logowanie trwa zbyt długo, spróbuj ponownie");
    await new Promise((r) => setTimeout(r, 1000));
  }
  const pair = await call<TokenPair>("/auth/token/redeem", { method: "POST", bearer: authToken });
  await save(db, pair);
  return pair.accessToken.token;
}

async function save(db: SupabaseClient, pair: TokenPair, keepRefresh?: { token: string; validUntil: string }) {
  const refresh = pair.refreshToken ?? keepRefresh;
  const { error } = await db.from("integration_tokens").upsert({
    provider: PROVIDER,
    access_token: pair.accessToken.token,
    expires_at: pair.accessToken.validUntil,
    refresh_token: refresh ? JSON.stringify(refresh) : null,
    refreshing_until: null,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

/** Ważny accessToken: z bazy, odświeżony refreshTokenem albo z nowego logowania. */
async function accessToken(db: SupabaseClient, force = false) {
  const { data: row } = await db.from("integration_tokens").select("*").eq("provider", PROVIDER).maybeSingle();
  if (row && !force && row.expires_at && Date.parse(row.expires_at) > Date.now() + 60_000) return row.access_token as string;
  const refresh = row?.refresh_token ? (JSON.parse(row.refresh_token) as { token: string; validUntil: string }) : null;
  if (refresh && Date.parse(refresh.validUntil) > Date.now() + 60_000) {
    try {
      const pair = await call<TokenPair>("/auth/token/refresh", { method: "POST", bearer: refresh.token });
      await save(db, pair, refresh);
      return pair.accessToken.token;
    } catch {
      // odświeżenie nieudane – pełne logowanie
    }
  }
  return authenticate(db);
}

async function authed<T>(db: SupabaseClient, path: string, init: { method?: string; body?: unknown } = {}) {
  try {
    return await call<T>(path, { ...init, bearer: await accessToken(db) });
  } catch (e) {
    if (e instanceof KsefError && e.status === 401) return call<T>(path, { ...init, bearer: await accessToken(db, true) });
    throw e;
  }
}

/** Sprawdzenie połączenia: logowanie tokenem (bez wysyłki faktur). */
export async function ksefCheck(db: SupabaseClient) {
  await accessToken(db, true);
  return { env: ksefEnv() };
}

/**
 * Wysyłka jednej faktury: sesja interaktywna FA(3) z nowym kluczem AES-256, faktura zaszyfrowana AES-CBC,
 * zamknięcie sesji. Zwraca numery referencyjne do sprawdzania statusu.
 */
export async function sendInvoice(db: SupabaseClient, xml: string) {
  return withFreshKeys(() => sendInvoiceOnce(db, xml));
}

async function sendInvoiceOnce(db: SupabaseClient, xml: string) {
  const content = Buffer.from(xml, "utf8");
  const key = randomBytes(32);
  const iv = randomBytes(16);
  const cert = await certFor("SymmetricKeyEncryption");
  const session = await authed<{ referenceNumber: string }>(db, "/sessions/online", {
    method: "POST",
    body: {
      formCode: { systemCode: "FA (3)", schemaVersion: "1-0E", value: "FA" },
      encryption: {
        encryptedSymmetricKey: rsaOaep(cert.certificate, key),
        initializationVector: iv.toString("base64"),
        ...(cert.publicKeyId ? { publicKeyId: cert.publicKeyId } : {}),
      },
    },
  });
  try {
    const cipher = createCipheriv("aes-256-cbc", key, iv);
    const encrypted = Buffer.concat([cipher.update(content), cipher.final()]);
    const sent = await authed<{ referenceNumber: string }>(db, `/sessions/online/${session.referenceNumber}/invoices`, {
      method: "POST",
      body: {
        invoiceHash: sha256b64(content),
        invoiceSize: content.length,
        encryptedInvoiceHash: sha256b64(encrypted),
        encryptedInvoiceSize: encrypted.length,
        encryptedInvoiceContent: encrypted.toString("base64"),
        offlineMode: false,
      },
    });
    return { sessionRef: session.referenceNumber, invoiceRef: sent.referenceNumber, hash: sha256b64(content) };
  } finally {
    // Zamknięcie sesji uruchamia przetwarzanie; status faktury sprawdzamy osobno.
    await authed(db, `/sessions/online/${session.referenceNumber}/close`, { method: "POST" }).catch(() => null);
  }
}

export type KsefInvoiceStatus = { code: number; description: string; ksefNumber: string | null; acquisitionDate: string | null };

export async function invoiceStatus(db: SupabaseClient, sessionRef: string, invoiceRef: string): Promise<KsefInvoiceStatus> {
  const r = await authed<{ ksefNumber?: string | null; acquisitionDate?: string | null; status: { code: number; description?: string; details?: string[]; extensions?: { originalKsefNumber?: string } } }>(
    db, `/sessions/${sessionRef}/invoices/${invoiceRef}`);
  const desc = [r.status.description, ...(r.status.details ?? [])].filter(Boolean).join(" – ");
  // 440 = numer faktury (P_2) już jest w KSeF dla tej firmy – to NIE jest przyjęcie tej faktury.
  const dup = r.status.code === 440 ? r.status.extensions?.originalKsefNumber : null;
  return {
    code: r.status.code,
    description: r.status.code === 440 ? `Numer faktury jest już użyty w KSeF${dup ? ` (dokument ${dup})` : ""}. ${desc}`.trim() : desc,
    ksefNumber: r.status.code === 200 ? r.ksefNumber ?? null : null,
    acquisitionDate: r.acquisitionDate ?? null,
  };
}

/** Link weryfikacyjny KOD I: {qr}/invoice/{NIP}/{DD-MM-RRRR}/{SHA-256 Base64URL}. */
export function verificationLink(sellerNip: string, issueDate: string, hashB64: string) {
  const [y, m, d] = issueDate.split("-");
  const urlHash = hashB64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${ksefQrBase()}/invoice/${sellerNip.replace(/\D/g, "")}/${d}-${m}-${y}/${urlHash}`;
}
