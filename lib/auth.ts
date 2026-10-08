import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type Profile = {
  id: string;
  email: string | null;
  full_name: string | null;
  role: "admin" | "staff";
  can_see_prices: boolean;
  active: boolean;
};

/**
 * Zalogowana osoba z profilem. Bez sesji → /login. Raz na zapytanie (cache): layout i strona
 * nie pytają bazy dwa razy. getClaims sprawdza token lokalnie, bez dodatkowego połączenia z Supabase Auth.
 */
export const requireProfile = cache(async () => {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getClaims();
  const userId = auth?.claims?.sub;
  if (!userId) redirect("/login");
  const { data: profile } = await supabase.from("profiles").select("*").eq("id", userId).single();
  if (!profile || !profile.active) redirect("/login?blad=konto");
  return { supabase, profile: profile as Profile };
});

export async function requireAdmin() {
  const ctx = await requireProfile();
  if (ctx.profile.role !== "admin") throw new Error("Ta czynność jest dostępna tylko dla administratora.");
  return ctx;
}
