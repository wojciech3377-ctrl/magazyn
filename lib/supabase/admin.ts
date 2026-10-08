import "server-only";
import { createClient } from "@supabase/supabase-js";
import { supabaseUrl } from "./url";

/**
 * Klient z kluczem service_role – omija RLS. Tylko dla zadań bez zalogowanej osoby
 * (webhooki Shopify, cykliczny odczyt zamówień z Base).
 */
export function createAdminClient() {
  const url = supabaseUrl();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Brak NEXT_PUBLIC_SUPABASE_URL lub SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
