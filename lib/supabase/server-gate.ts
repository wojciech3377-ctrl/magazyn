import "server-only";
import { createHash, createHmac } from "node:crypto";
import { createAdminClient } from "./admin";

/**
 * Klucz serwera do bazy (SQL 77): baza odpowiada pracownikom tylko na zapytania z serwera aplikacji.
 * Nagłówek wyliczany z klucza service_role (zna go tylko serwer), w bazie leży tylko jego skrót SHA-256.
 * Token logowania z przeglądarki sam nie wystarczy – bez nagłówka is_staff() / is_admin() zwracają false.
 */
export const SERVER_HEADER = "x-magazyn-server";

let cached: string | null | undefined;
export function serverHeaderValue(): string | null {
  if (cached !== undefined) return cached;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  cached = key ? createHmac("sha256", key).update("magazyn-db-gate-v1").digest("hex") : null;
  return cached;
}

export function serverHeaders(): Record<string, string> {
  const v = serverHeaderValue();
  return v ? { [SERVER_HEADER]: v } : {};
}

/**
 * Zapisuje w bazie skrót nagłówka (raz na instancję serwera; po zmianie klucza service_role – sam się poprawi).
 * Bez SQL 77 (brak tabeli) – próbuje ponownie co 10 minut.
 */
let syncedAt = 0;
let syncing: Promise<void> | null = null;
export function syncServerKey(): Promise<void> {
  if (syncedAt && Date.now() - syncedAt < 10 * 60_000) return Promise.resolve();
  syncing ??= (async () => {
    const v = serverHeaderValue();
    if (!v) return;
    const hash = createHash("sha256").update(v).digest("hex");
    try {
      const db = createAdminClient();
      const { data, error } = await db.from("server_keys").select("key_hash").eq("id", 1).maybeSingle();
      if (error) return; // brak SQL 77 – baza działa jak dotąd
      if (data?.key_hash !== hash) await db.from("server_keys").upsert({ id: 1, key_hash: hash, updated_at: new Date().toISOString() });
    } catch {
      // bez połączenia – spróbujemy przy następnym zapytaniu
    } finally {
      syncedAt = Date.now();
      syncing = null;
    }
  })();
  return syncing;
}
