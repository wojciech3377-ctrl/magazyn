import { createServerClient } from "@supabase/ssr";
import { supabaseUrl } from "./url";
import { cookies } from "next/headers";
import { serverHeaders, syncServerKey } from "./server-gate";

/** Klient Supabase działający w imieniu zalogowanej osoby (RLS obowiązuje). */
export async function createClient() {
  const cookieStore = await cookies();
  // Klucz serwera (SQL 77) – zapisuje się w bazie raz na instancję; bez czekania na wynik.
  void syncServerKey();
  return createServerClient(
    supabaseUrl(),
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // Nagłówek, który zna tylko serwer – bez niego baza nie odpowiada pracownikom (SQL 77).
      global: { headers: serverHeaders() },
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            // Ciasteczka sesji niedostępne dla JavaScriptu (ochrona przed kradzieżą sesji przez XSS).
            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, { ...options, httpOnly: true, sameSite: "lax" }));
          } catch {
            // Wywołane z komponentu serwerowego – sesję odświeża proxy.ts.
          }
        },
      },
    },
  );
}
