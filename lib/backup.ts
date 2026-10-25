import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { gzipSync } from "node:zlib";

/**
 * Kopia zapasowa danych aplikacji: wszystkie ważne tabele jako JSON (spakowany gzip) w prywatnym miejscu „backups”
 * w Supabase Storage. Bez tajnych danych (klucze integracji, liczniki logowań, dziennik synchronizacji).
 * Pliki umów zostają w swoim miejscu („contracts”) – ich kopia to osobny ZIP za miesiąc.
 */

// [tabela, kolumny sortowania do stronicowania]
const TABLES: [string, string[]][] = [
  ["stores", ["id"]], ["locations", ["id"]], ["profiles", ["id"]], ["app_settings", ["key"]], ["catalog_exclusions", ["id"]],
  ["products", ["id"]], ["variants", ["id"]], ["variant_store_links", ["id"]], ["product_store_links", ["id"]],
  ["units", ["id"]], ["unit_events", ["id"]], ["deliveries", ["id"]], ["stock_transfers", ["id"]], ["stock_transfer_items", ["transfer_id", "unit_id"]],
  ["contracts", ["id"]], ["contract_events", ["id"]], ["consignors", ["id"]], ["consignor_payouts", ["id"]], ["consignor_intakes", ["id"]],
  ["consignor_intake_items", ["id"]], ["consignor_shipments", ["id"]],
  ["orders", ["id"]], ["sales", ["id"]], ["shipments", ["id"]], ["customers", ["id"]],
  ["invoices", ["id"]], ["invoice_items", ["id"]], ["invoice_counters", ["series", "year"]], ["receipts", ["id"]], ["receipt_jobs", ["id"]],
  ["pos_orders", ["id"]], ["pos_order_items", ["id"]], ["pos_products", ["id"]], ["cash_movements", ["id"]],
  ["wtb_items", ["id"]], ["tasks", ["id"]], ["jpk_notes", ["line_key"]], ["variant_price_history", ["id"]], ["fiscal_printers", ["id"]],
];

/** Usuwa z ustawień wszystko, co wygląda na hasło / klucz (na wszelki wypadek – sekrety i tak są w Vercel / Vault). */
function scrub(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>)
      .filter(([k]) => !/pass|secret|token|api_?key|private/i.test(k))
      .map(([k, x]) => [k, scrub(x)]));
  }
  return v;
}

async function readAll(db: SupabaseClient, table: string, order: string[]) {
  const rows: unknown[] = [];
  for (let from = 0; from < 2_000_000; from += 1000) {
    let q = db.from(table).select("*");
    for (const c of order) q = q.order(c);
    const { data, error } = await q.range(from, from + 999);
    if (error) {
      // Tabela z innym kluczem (np. starsza baza) – bez sortowania, najwyżej 1000 wierszy.
      if (from === 0 && /column .* does not exist/i.test(error.message)) {
        const r = await db.from(table).select("*").limit(1000);
        if (r.error) throw r.error;
        return r.data ?? [];
      }
      throw error;
    }
    rows.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return rows;
}

export type BackupFile = { name: string; path: string; size: number | null; created_at: string | null };

/** Kopia teraz: plik backups/baza/YYYY-MM-DD_HH-MM.json.gz. Zwraca ścieżkę i liczbę wierszy w tabelach. */
export async function createDbBackup(db: SupabaseClient) {
  const started = Date.now();
  const data: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  const skipped: Record<string, string> = {};
  for (const [t, order] of TABLES) {
    try {
      const rows = await readAll(db, t, order);
      data[t] = t === "app_settings" ? rows.map(scrub) : rows;
      counts[t] = rows.length;
    } catch (e) {
      skipped[t] = (e as { message?: string })?.message ?? String(e);
    }
  }
  const stamp = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw", dateStyle: "short", timeStyle: "short" }).format(new Date()).replace(" ", "_").replace(":", "-");
  const payload = { app: "magazyn", created_at: new Date().toISOString(), counts, skipped, data };
  const gz = gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9 });
  const path = `baza/${stamp}.json.gz`;
  const { error } = await db.storage.from("backups").upload(path, gz, { contentType: "application/gzip", upsert: true });
  if (error) throw new Error(/bucket|not found/i.test(error.message) ? "Brak miejsca na kopie – uruchom SQL 73 w Supabase." : error.message);
  return { path, size: gz.length, counts, skipped, seconds: Math.round((Date.now() - started) / 1000) };
}

/** Lista kopii (najnowsze najpierw) w folderze backups/<folder>. */
export async function listBackups(db: SupabaseClient, folder: "baza" | "umowy"): Promise<BackupFile[]> {
  const { data } = await db.storage.from("backups").list(folder, { limit: 200, sortBy: { column: "name", order: "desc" } });
  return (Array.isArray(data) ? data : []).filter((f) => f.name && !f.name.startsWith(".")).map((f) => ({
    name: f.name, path: `${folder}/${f.name}`,
    size: (f.metadata as { size?: number } | null)?.size ?? null, created_at: f.created_at ?? null,
  }));
}

/** Kopie bazy starsze niż `days` dni – usuwane (zostaje co najmniej 7 najnowszych). */
export async function pruneBackups(db: SupabaseClient, days = 30) {
  const files = await listBackups(db, "baza");
  const cutoff = Date.now() - days * 86400_000;
  const old = files.slice(7).filter((f) => f.created_at && Date.parse(f.created_at) < cutoff).map((f) => f.path);
  if (old.length) await db.storage.from("backups").remove(old);
  return old.length;
}

/** ZIP z plikami umów z danego miesiąca (wg daty utworzenia umowy) – w backups/umowy/umowy-YYYY-MM.zip. */
export async function createContractsArchive(db: SupabaseClient, month: string) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("Wybierz miesiąc.");
  const [y, m] = month.split("-").map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1)).toISOString();
  const to = new Date(Date.UTC(y, m, 1)).toISOString();
  const ids: string[] = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await db.from("contracts").select("id").gte("created_at", from).lt("created_at", to)
      .not("status", "in", "(cancelled)").order("id").range(off, off + 999);
    if (error) throw error;
    ids.push(...(data ?? []).map((c) => c.id as string));
    if ((data ?? []).length < 1000) break;
  }
  if (!ids.length) throw new Error("W tym miesiącu nie ma umów.");
  const { contractsZip } = await import("@/lib/contracts/zip");
  const zip = await contractsZip(db, ids.map((id) => ({ contractId: id, prefix: "" })), true);
  if (!zip) throw new Error("W tym miesiącu nie ma plików umów.");
  const path = `umowy/umowy-${month}.zip`;
  const { error } = await db.storage.from("backups").upload(path, zip, { contentType: "application/zip", upsert: true });
  if (error) throw new Error(/bucket|not found/i.test(error.message) ? "Brak miejsca na kopie – uruchom SQL 73 w Supabase." : error.message);
  return { path, contracts: ids.length, size: zip.length };
}

/** Link do pobrania kopii (ważny 10 minut). */
export async function backupUrl(db: SupabaseClient, path: string) {
  if (!/^(baza|umowy)\/[A-Za-z0-9_.\-]+$/.test(path)) return null;
  const { data } = await db.storage.from("backups").createSignedUrl(path, 600, { download: true });
  return data?.signedUrl ?? null;
}

/**
 * Dziennik automatu (sync_log) rośnie o kilkadziesiąt tysięcy wpisów miesięcznie (zadania co minutę) – bez czyszczenia
 * zająłby z czasem większość bazy. Usuwane: udane wpisy starsze niż 30 dni, błędy starsze niż 90 dni
 * (porcjami po numerze wpisu, żeby jedno zapytanie nie trwało za długo).
 */
export async function pruneSyncLog(db: SupabaseClient, deadline = Date.now() + 60_000) {
  let removed = 0;
  for (const [okOnly, days] of [[true, 30], [false, 90]] as const) {
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
    while (Date.now() < deadline) {
      // Porcja najstarszych wpisów do usunięcia: zakres numerów + ten sam warunek daty (kolejność numerów nie musi
      // zgadzać się z datami).
      let pick = db.from("sync_log").select("id").lt("created_at", cutoff).order("id").limit(1000); // PostgREST oddaje najwyżej 1000
      if (okOnly) pick = pick.eq("ok", true);
      const { data, error: pe } = await pick;
      if (pe) throw pe;
      if (!data?.length) break;
      let q = db.from("sync_log").delete({ count: "exact" }).gte("id", data[0].id).lte("id", data[data.length - 1].id).lt("created_at", cutoff);
      if (okOnly) q = q.eq("ok", true);
      const { count, error } = await q;
      if (error) throw error;
      removed += count ?? 0;
      if (data.length < 1000) break;
    }
  }
  return removed;
}

const FILES_DIR = "umowy-pliki";
const dirOf = (p: string) => p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";

/** Pliki umów (ścieżki z contracts.file_path). */
async function contractFilePaths(db: SupabaseClient) {
  const rows: { id: string; file_path: string }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("contracts").select("id, file_path").not("file_path", "is", null).order("id").range(from, from + 999);
    if (error) throw error;
    rows.push(...((data ?? []) as { id: string; file_path: string }[]));
    if ((data ?? []).length < 1000) break;
  }
  return rows.filter((r) => /^[A-Za-z0-9_\-/]+\.[A-Za-z0-9]{1,5}$/.test(r.file_path) && !r.file_path.includes(".."));
}

/** Pliki w kopii (backups/umowy-pliki/<folder>) z datą skopiowania. */
async function backedUpFiles(db: SupabaseClient, dir: string) {
  const out = new Map<string, string | null>();
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await db.storage.from("backups").list(`${FILES_DIR}/${dir}`.replace(/\/$/, ""), { limit: 1000, offset });
    if (error) throw new Error(/bucket|not found/i.test(error.message) ? "Brak miejsca na kopie – uruchom SQL 73 w Supabase." : error.message);
    for (const f of data ?? []) if (f.id) out.set(dir ? `${dir}/${f.name}` : f.name, f.created_at ?? null);
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

/**
 * Pliki umów do kopii: tylko te, których jeszcze w niej nie ma (backups/umowy-pliki/<ta sama ścieżka>).
 * Kopiowanie po stronie Supabase – pliki nie są pobierane (bez transferu), kopia zostaje na stałe
 * (także po usunięciu umowy albo pliku w aplikacji).
 */
export async function backupContractFiles(db: SupabaseClient, deadline = Date.now() + 90_000) {
  const files = await contractFilePaths(db);
  const byDir = new Map<string, string[]>();
  for (const f of files) byDir.set(dirOf(f.file_path), [...(byDir.get(dirOf(f.file_path)) ?? []), f.file_path]);
  let copied = 0, already = 0, missing = 0;
  const errors: string[] = [];
  for (const [dir, paths] of byDir) {
    if (Date.now() > deadline) break;
    const have = await backedUpFiles(db, dir);
    for (const p of [...new Set(paths)]) {
      if (have.has(p)) { already++; continue; }
      if (Date.now() > deadline) break;
      const { error } = await db.storage.from("contracts").copy(p, `${FILES_DIR}/${p}`, { destinationBucket: "backups" });
      if (!error) copied++;
      else if (/not.?found|does not exist/i.test(error.message)) missing++; // plik usunięty ręcznie w Supabase
      else if (errors.length < 3) errors.push(`${p}: ${error.message}`);
    }
  }
  return { copied, already, missing, total: files.length, ...(errors.length ? { errors } : {}) };
}

/**
 * ZIP z plikami umów, które trafiły do kopii od ostatniego takiego pobrania (do zapisania poza Supabase).
 * Najwyżej 300 umów naraz – reszta przy kolejnym kliknięciu. ZIP leży w backups/umowy (30 dni).
 */
export async function createNewContractsArchive(db: SupabaseClient) {
  await backupContractFiles(db, Date.now() + 60_000);
  const { data: st } = await db.from("sync_state").select("value").eq("key", "contracts_new_download").maybeSingle();
  const since = (st?.value as { at?: string } | null)?.at ?? "1970-01-01T00:00:00Z";
  const files = await contractFilePaths(db);
  const dirs = [...new Set(files.map((f) => dirOf(f.file_path)))];
  const copiedAt = new Map<string, string | null>();
  for (const d of dirs) for (const [p, at] of await backedUpFiles(db, d)) copiedAt.set(p, at);
  const fresh = files
    .map((f) => ({ ...f, at: copiedAt.get(f.file_path) ?? null }))
    .filter((f) => f.at && Date.parse(f.at) > Date.parse(since))
    .sort((a, b) => Date.parse(a.at!) - Date.parse(b.at!));
  if (!fresh.length) throw new Error("Nie ma nowych plików umów od ostatniego pobrania.");
  const batch = fresh.slice(0, 300);
  const { contractsZip } = await import("@/lib/contracts/zip");
  const zip = await contractsZip(db, [...new Set(batch.map((f) => f.id))].map((id) => ({ contractId: id, prefix: "" })), true);
  if (!zip) throw new Error("Nie udało się przygotować plików umów.");
  const stamp = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw", dateStyle: "short", timeStyle: "medium" }).format(new Date()).replace(" ", "_").replace(/:/g, "-");
  const path = `umowy/nowe-${stamp}.zip`;
  const { error } = await db.storage.from("backups").upload(path, zip, { contentType: "application/zip", upsert: true });
  if (error) throw new Error(error.message);
  // Znacznik dopiero po zapisaniu ZIP-a (gdyby się nie udało – te same pliki pójdą następnym razem).
  await db.from("sync_state").upsert({ key: "contracts_new_download", value: { at: batch[batch.length - 1].at }, updated_at: new Date().toISOString() });
  return { path, contracts: batch.length, left: fresh.length - batch.length };
}

/** ZIP-y „nowe umowy” starsze niż 30 dni – usuwane (pliki i tak są w kopii umowy-pliki). */
export async function pruneNewContractZips(db: SupabaseClient, days = 30) {
  const files = await listBackups(db, "umowy");
  const cutoff = Date.now() - days * 86400_000;
  const old = files.filter((f) => f.name.startsWith("nowe-") && f.created_at && Date.parse(f.created_at) < cutoff).map((f) => f.path);
  if (old.length) await db.storage.from("backups").remove(old);
  return old.length;
}
