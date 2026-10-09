import "server-only";
import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Furgonetka REST API (OAuth2). Klucze aplikacji: FURGONETKA_CLIENT_ID / FURGONETKA_CLIENT_SECRET w Vercel.
 * Połączenie z kontem robi administrator w Ustawieniach (logowanie na stronie Furgonetki) – tokeny trafiają
 * do tabeli integration_tokens, dostępnej tylko dla serwera. Token odświeżający działa raz, więc odświeżanie
 * ma blokadę (refreshing_until), żeby dwa równoległe zadania nie unieważniły sobie sesji.
 */

const PROVIDER = "furgonetka";

export function furgonetkaApiUrl() {
  return (process.env.FURGONETKA_API_URL || "https://api.furgonetka.pl").replace(/\/$/, "");
}

export function furgonetkaConfigured() {
  return !!(process.env.FURGONETKA_CLIENT_ID && process.env.FURGONETKA_CLIENT_SECRET);
}

export class FurgonetkaError extends Error {
  constructor(public status: number, message: string) {
    super(`Furgonetka: ${message}`);
  }
}

function basicAuth() {
  const id = process.env.FURGONETKA_CLIENT_ID;
  const secret = process.env.FURGONETKA_CLIENT_SECRET;
  if (!id || !secret) throw new FurgonetkaError(0, "brak FURGONETKA_CLIENT_ID / FURGONETKA_CLIENT_SECRET w ustawieniach serwera");
  return `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
}

export function authorizeUrl(redirectUri: string, state: string) {
  const u = new URL(`${furgonetkaApiUrl()}/oauth/authorize`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", process.env.FURGONETKA_CLIENT_ID ?? "");
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("scope", "api");
  u.searchParams.set("state", state);
  return u.toString();
}

export function newState() {
  return crypto.randomBytes(24).toString("hex");
}

type TokenResponse = { access_token: string; refresh_token?: string; expires_in?: number };

async function tokenRequest(params: Record<string, string>) {
  const res = await fetch(`${furgonetkaApiUrl()}/oauth/token`, {
    method: "POST",
    headers: { Authorization: basicAuth(), "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params),
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) throw new FurgonetkaError(res.status, `logowanie nie powiodło się (${res.status}): ${text.replace(/\s+/g, " ").slice(0, 200)}`);
  return JSON.parse(text) as TokenResponse;
}

async function saveTokens(db: SupabaseClient, t: TokenResponse, userId?: string | null) {
  const row: Record<string, unknown> = {
    provider: PROVIDER,
    access_token: t.access_token,
    refresh_token: t.refresh_token ?? null,
    expires_at: new Date(Date.now() + (t.expires_in ?? 2_592_000) * 1000).toISOString(),
    refreshing_until: null,
    updated_at: new Date().toISOString(),
  };
  if (userId !== undefined) row.connected_by = userId;
  const { error } = await db.from("integration_tokens").upsert(row);
  if (error) throw error;
}

export async function exchangeCode(db: SupabaseClient, code: string, redirectUri: string, userId: string) {
  const t = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
  await saveTokens(db, t, userId);
}

export async function furgonetkaConnection(db: SupabaseClient) {
  const { data } = await db.from("integration_tokens").select("expires_at, updated_at, refresh_token").eq("provider", PROVIDER).maybeSingle();
  return data ? { expiresAt: data.expires_at as string | null, updatedAt: data.updated_at as string, refreshable: !!data.refresh_token } : null;
}

export async function disconnect(db: SupabaseClient) {
  await db.from("integration_tokens").delete().eq("provider", PROVIDER);
}

/** Ważny token dostępu; odświeża go na dzień przed wygaśnięciem. */
async function accessToken(db: SupabaseClient, force = false): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: row } = await db.from("integration_tokens").select("*").eq("provider", PROVIDER).maybeSingle();
    if (!row) throw new FurgonetkaError(0, "aplikacja nie jest połączona z Furgonetką (Ustawienia → Furgonetka)");
    const expires = row.expires_at ? new Date(row.expires_at).getTime() : 0;
    if (!force && expires > Date.now() + 24 * 3600_000) return row.access_token as string;
    if (!row.refresh_token) {
      if (expires > Date.now()) return row.access_token as string;
      throw new FurgonetkaError(401, "sesja Furgonetki wygasła – połącz ponownie w Ustawieniach");
    }
    // Blokada: tylko jedno odświeżenie naraz.
    const lockUntil = new Date(Date.now() + 30_000).toISOString();
    const { data: locked } = await db
      .from("integration_tokens")
      .update({ refreshing_until: lockUntil })
      .eq("provider", PROVIDER)
      .eq("updated_at", row.updated_at)
      .or(`refreshing_until.is.null,refreshing_until.lt.${new Date().toISOString()}`)
      .select("provider");
    if (!locked?.length) {
      await new Promise((r) => setTimeout(r, 1500));
      force = false;
      continue;
    }
    try {
      const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: row.refresh_token as string });
      await saveTokens(db, t);
      return t.access_token;
    } catch (e) {
      await db.from("integration_tokens").update({ refreshing_until: null }).eq("provider", PROVIDER);
      if (expires > Date.now() && !force) return row.access_token as string;
      throw e;
    }
  }
  throw new FurgonetkaError(0, "nie udało się odświeżyć sesji Furgonetki, spróbuj za chwilę");
}

const VND = "application/vnd.furgonetka.v1+json";
let contentType = VND;

/** Zapytanie do API; przy 401 jedno wymuszone odświeżenie tokenu. */
export async function furgonetkaFetch(db: SupabaseClient, path: string, init: { method?: string; body?: unknown; accept?: string } = {}) {
  let token = await accessToken(db);
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${furgonetkaApiUrl()}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: init.accept ?? `${contentType}, application/json;q=0.9, */*;q=0.5`,
        ...(init.body !== undefined ? { "Content-Type": contentType } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
    });
    if (res.status === 401 && attempt === 0) {
      token = await accessToken(db, true);
      continue;
    }
    if ((res.status === 406 || res.status === 415) && contentType === VND) {
      contentType = "application/json";
      continue;
    }
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      continue;
    }
    return res;
  }
  throw new FurgonetkaError(0, "brak odpowiedzi API");
}

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) throw new FurgonetkaError(res.status, describeError(text, res.status));
  return (text ? JSON.parse(text) : {}) as T;
}

function describeError(text: string, status: number) {
  try {
    const body = JSON.parse(text) as { errors?: { path?: string; message?: string }[]; message?: string; error_description?: string };
    if (body.errors?.length) return body.errors.map((e) => [e.path, e.message].filter(Boolean).join(": ")).join("; ");
    return body.message ?? body.error_description ?? `błąd ${status}`;
  } catch {
    return `błąd ${status}: ${text.replace(/\s+/g, " ").slice(0, 200)}`;
  }
}

export type FurgonetkaParcel = {
  package_no: string | null;
  state: string | null;
  state_description: string | null;
  tracking_url: string | null;
  datetime_status: string | null;
  service?: string | null;
};

export type FurgonetkaPackage = {
  package_id: string;
  service: string | null;
  service_id?: number;
  state: string | null;
  user_reference_number: string | null;
  order_number?: string | null;
  datetime_add?: string | null;
  receiver?: { name?: string | null; email?: string | null; point?: string | null } | null;
  parcels: FurgonetkaParcel[];
};

export async function listPackages(db: SupabaseClient, opts: { limit?: number; lastPackageId?: string | null } = {}) {
  const q = new URLSearchParams({ limit: String(opts.limit ?? 50) });
  if (opts.lastPackageId) q.set("last_package_id", opts.lastPackageId);
  const res = await furgonetkaFetch(db, `/packages?${q}`);
  const body = await json<{ packages?: FurgonetkaPackage[]; pagination?: { last_package_id?: string | null; has_more?: boolean } } | FurgonetkaPackage[]>(res);
  if (Array.isArray(body)) return { packages: body, last: body.at(-1)?.package_id ?? null, hasMore: body.length >= (opts.limit ?? 50) };
  return { packages: body.packages ?? [], last: body.pagination?.last_package_id ?? null, hasMore: !!body.pagination?.has_more };
}

export async function getPackage(db: SupabaseClient, id: string) {
  return json<FurgonetkaPackage>(await furgonetkaFetch(db, `/packages/${encodeURIComponent(id)}`));
}

export type Address = {
  name?: string | null;
  company?: string | null;
  street: string;
  postcode: string;
  city: string;
  country_code: string;
  email?: string | null;
  phone?: string | null;
  point?: string | null;
};

export type NewPackage = {
  pickup: Address;
  sender?: Address;
  receiver: Address;
  service_id: number;
  type: "package";
  user_reference_number?: string;
  parcels: { width: number; depth: number; height: number; weight: number; value?: number; description?: string }[];
  additional_services?: Record<string, unknown>;
};

export async function createPackage(db: SupabaseClient, body: NewPackage) {
  return json<FurgonetkaPackage>(await furgonetkaFetch(db, "/packages", { method: "POST", body }));
}

export async function deletePackage(db: SupabaseClient, id: string) {
  const res = await furgonetkaFetch(db, `/packages/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) await json(res);
}

/** Zamówienie (nadanie) przesyłek; czeka do ~15 s na wynik. */
export async function orderPackages(db: SupabaseClient, packageIds: string[]) {
  const uuid = crypto.randomUUID();
  await json(await furgonetkaFetch(db, `/order-commands/${uuid}`, { method: "PUT", body: { packages: packageIds.map((id) => ({ id: Number(id) || id })) } }));
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const s = await json<{ status: string; errors?: { path?: string; message?: string }[] }>(await furgonetkaFetch(db, `/order-commands/${uuid}`));
    if (s.status === "successful" || s.status === "success" || s.status === "done") return;
    if (s.status === "failed" || s.status === "error" || s.errors?.length) {
      throw new FurgonetkaError(422, s.errors?.map((e) => [e.path, e.message].filter(Boolean).join(": ")).join("; ") || "nie udało się nadać przesyłki");
    }
  }
}

/** Etykieta PDF przesyłki. API zwraca PDF albo JSON z plikiem w base64 / adresem. */
export async function getLabel(db: SupabaseClient, id: string): Promise<Uint8Array> {
  const res = await furgonetkaFetch(db, `/packages/${encodeURIComponent(id)}/label`, { accept: `application/pdf, ${VND}, application/json` });
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok) throw new FurgonetkaError(res.status, describeError(await res.text(), res.status));
  if (type.includes("pdf") || type.includes("octet-stream")) return new Uint8Array(await res.arrayBuffer());
  const body = (await res.json()) as Record<string, unknown>;
  const candidates = [body.label, body.file, body.content, body.data, (body.label as Record<string, unknown> | undefined)?.file, (body.labels as unknown[] | undefined)?.[0]];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 100) return Uint8Array.from(Buffer.from(c.replace(/^data:[^,]+,/, ""), "base64"));
    if (c && typeof c === "object") {
      const o = c as Record<string, unknown>;
      const f = o.file ?? o.content ?? o.data;
      if (typeof f === "string" && f.length > 100) return Uint8Array.from(Buffer.from(f.replace(/^data:[^,]+,/, ""), "base64"));
    }
  }
  const url = [body.url, (body.label as Record<string, unknown> | undefined)?.url].find((u): u is string => typeof u === "string");
  if (url) {
    const r = await fetch(url, { cache: "no-store" });
    if (r.ok) return new Uint8Array(await r.arrayBuffer());
  }
  throw new FurgonetkaError(0, "etykieta nie jest jeszcze gotowa – spróbuj za chwilę");
}

/** Identyfikatory usług na koncie (np. InPost, DPD). */
export async function accountServices(db: SupabaseClient) {
  const body = await json<{ services?: { id: number; service: string; name: string }[] }>(await furgonetkaFetch(db, "/account/services"));
  return body.services ?? [];
}

/** Anulowanie przesyłek (dopóki kurier ich nie odebrał). */
export async function cancelPackages(db: SupabaseClient, packageIds: string[]) {
  const uuid = crypto.randomUUID();
  await json(await furgonetkaFetch(db, `/cancel-command/${uuid}`, { method: "PUT", body: { packages: packageIds.map((id) => ({ id: Number(id) || id })) } }));
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const s = await json<{ status: string; errors?: { path?: string; message?: string }[] }>(await furgonetkaFetch(db, `/cancel-command/${uuid}`));
    if (s.status === "successful" || s.status === "success" || s.status === "done") return;
    if (s.status === "failed" || s.status === "error" || s.errors?.length) {
      throw new FurgonetkaError(422, s.errors?.map((e) => [e.path, e.message].filter(Boolean).join(": ")).join("; ") || "nie udało się anulować przesyłki");
    }
  }
}
