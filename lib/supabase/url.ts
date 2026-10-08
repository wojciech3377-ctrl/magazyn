/** Adres projektu Supabase bez ścieżki (np. gdy w Vercel wklejono https://xxx.supabase.co/rest/v1/). */
export function supabaseUrl() {
  const raw = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
  try {
    return new URL(raw).origin;
  } catch {
    return raw;
  }
}
