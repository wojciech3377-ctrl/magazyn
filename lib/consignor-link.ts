import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/** Czy konto pracownika jest też kontem komisanta (link „Mój komis” w menu). Pamięć 1 min. */
const cache = new Map<string, { at: number; v: boolean }>();

export async function isConsignorToo(userId: string) {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  try {
    const { data } = await createAdminClient().from("consignors").select("id").eq("user_id", userId).maybeSingle();
    cache.set(userId, { at: Date.now(), v: !!data });
    if (cache.size > 500) cache.delete(cache.keys().next().value!);
    return !!data;
  } catch {
    return false;
  }
}

/** Po połączeniu / odłączeniu konta – od razu nowa wartość. */
export function forgetConsignorLink(userId?: string | null) {
  if (userId) cache.delete(userId);
  else cache.clear();
}
