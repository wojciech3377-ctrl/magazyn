import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { can, homeFor, SECTIONS, type Section } from "@/lib/permissions";

export type Profile = {
  id: string;
  email: string | null;
  full_name: string | null;
  role: "admin" | "staff";
  can_see_prices: boolean;
  active: boolean;
  /** Działy dostępne dla pracownika (administrator ma wszystkie). */
  permissions: string[] | null;
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
  const { data: profile } = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
  if (!profile) {
    // Konto komisanta nie ma profilu pracownika → jego panel.
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const { data: consignor } = await createAdminClient().from("consignors").select("id").eq("user_id", userId).maybeSingle();
    redirect(consignor ? "/komis" : "/login?blad=konto");
  }
  if (!profile.active) redirect("/login?blad=konto");
  return { supabase, profile: profile as Profile };
});

export async function requireAdmin() {
  const ctx = await requireProfile();
  if (ctx.profile.role !== "admin") throw new Error("Ta czynność jest dostępna tylko dla administratora.");
  return ctx;
}

/**
 * Akcje serwera działu: pracownik musi mieć dostęp do któregoś z podanych działów
 * (administrator zawsze). Bez dostępu – błąd (przycisków i tak nie widzi).
 */
export async function requireSection(...sections: Section[]) {
  const ctx = await requireProfile();
  if (!sections.some((s) => can(ctx.profile, s))) {
    const names = sections.map((s) => SECTIONS.find((x) => x.key === s)?.label ?? s).join(" / ");
    throw new Error(`Brak uprawnień do działu: ${names}. Poproś administratora o dostęp (Pracownicy).`);
  }
  return ctx;
}

/** Strony działu (layout): bez dostępu → pierwszy dział, do którego pracownik ma dostęp. */
export async function guardSection(...sections: Section[]) {
  const ctx = await requireProfile();
  if (!sections.some((s) => can(ctx.profile, s))) redirect(homeFor(ctx.profile));
  return ctx;
}

/** Strony tylko dla administratora (Ustawienia, Pracownicy). */
export async function guardAdmin() {
  const ctx = await requireProfile();
  if (ctx.profile.role !== "admin") redirect(homeFor(ctx.profile));
  return ctx;
}
