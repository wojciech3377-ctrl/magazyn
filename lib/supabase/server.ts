import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/** Klient Supabase działający w imieniu zalogowanej osoby (RLS obowiązuje). */
export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
          } catch {
            // Wywołane z komponentu serwerowego – sesję odświeża proxy.ts.
          }
        },
      },
    },
  );
}
