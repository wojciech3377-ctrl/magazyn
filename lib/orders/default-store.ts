import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Sklep pokazywany domyślnie w Sprzedaż → Zamówienia (Ustawienia → Sklepy). Bez ustawienia: Sneakers Depot.
 * Zwraca id sklepu albo „wszystkie”.
 */
export async function defaultOrderStore(db: SupabaseClient, stores: { id: string; name: string }[]) {
  const { data } = await db.from("app_settings").select("value").eq("key", "orders").maybeSingle();
  const v = (data?.value as { default_store?: string } | null)?.default_store;
  if (v === "wszystkie" || (v && stores.some((s) => s.id === v))) return v;
  return stores.find((s) => /sneakers/i.test(s.name))?.id ?? "wszystkie";
}
