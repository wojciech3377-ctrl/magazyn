import "server-only";
import crypto from "node:crypto";
import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Zabezpieczenia wspólne: limity prób, adres IP klienta, bezpieczne porównanie sekretów i dziennik zdarzeń.
 * Limity działają po migracji 0042 – bez niej (brak funkcji w bazie) niczego nie blokują.
 */

/** Porównanie sekretów w stałym czasie (bez ataku czasowego). */
export function safeEqual(a: string | null | undefined, b: string | null | undefined) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}

/** IP klienta. Na Vercel nagłówek x-forwarded-for ustawia platforma (pierwszy adres to klient). */
export function ipFrom(h: Headers) {
  const raw = h.get("x-real-ip") || (h.get("x-forwarded-for") ?? "").split(",")[0];
  return raw.trim().slice(0, 64) || "unknown";
}

export async function clientIp() {
  return ipFrom(await headers());
}

/**
 * Jedno „uderzenie” w limit. Zwraca true, gdy jeszcze wolno (≤ max w oknie), false – gdy zablokowane.
 * Błąd bazy (np. brak migracji) nie blokuje działania aplikacji.
 */
export async function rateLimit(key: string, max: number, windowSeconds: number) {
  try {
    const { data, error } = await createAdminClient().rpc("rate_limit_hit", { p_key: key, p_max: max, p_window_seconds: windowSeconds });
    if (error) return true;
    return data !== false;
  } catch {
    return true;
  }
}

export async function rateLimitReset(key: string) {
  try {
    await createAdminClient().rpc("rate_limit_reset", { p_key: key });
  } catch {
    // bez znaczenia
  }
}

/** Zapis do dziennika bezpieczeństwa (widoczny dla administratora w Pracownicy). */
export async function securityEvent(kind: string, subject: string | null, detail?: Record<string, unknown>, h?: Headers) {
  try {
    const hh = h ?? (await headers());
    await createAdminClient().from("security_events").insert({
      kind,
      subject: subject?.slice(0, 200) ?? null,
      ip: ipFrom(hh),
      user_agent: (hh.get("user-agent") ?? "").slice(0, 300) || null,
      detail: detail ?? null,
    });
  } catch {
    // dziennik nie może zatrzymać działania
  }
}
