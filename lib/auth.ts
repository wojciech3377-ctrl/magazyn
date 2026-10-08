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

/** Zalogowana osoba z profilem. Bez sesji → /login. */
export async function requireProfile() {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/login");
  const { data: profile } = await supabase.from("profiles").select("*").eq("id", auth.user.id).single();
  if (!profile || !profile.active) redirect("/login?blad=konto");
  return { supabase, profile: profile as Profile };
}

export async function requireAdmin() {
  const ctx = await requireProfile();
  if (ctx.profile.role !== "admin") throw new Error("Ta czynność jest dostępna tylko dla administratora.");
  return ctx;
}
