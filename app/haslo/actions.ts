"use server";

import { redirect } from "next/navigation";
import { createClient as createPlainClient } from "@supabase/supabase-js";
import { forgetProfile, requireProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { supabaseUrl } from "@/lib/supabase/url";
import { rateLimit, securityEvent } from "@/lib/security";

export type PasswordState = { error?: string } | null;

/** Pracownik ustawia własne hasło (obowiązkowo po haśle startowym; albo zwykła zmiana z menu). */
export async function setStaffPassword(_: PasswordState, fd: FormData): Promise<PasswordState> {
  const { profile } = await requireProfile();
  const password = String(fd.get("password") ?? "");
  const repeat = String(fd.get("repeat") ?? "");
  if (password.length < 10) return { error: "Hasło musi mieć co najmniej 10 znaków." };
  if (!/[A-Za-ząćęłńóśźżĄĆĘŁŃÓŚŹŻ]/.test(password) || !/\d/.test(password)) return { error: "Hasło musi zawierać litery i cyfry." };
  if (password !== repeat) return { error: "Hasła nie są takie same." };
  if (!(await rateLimit(`password:${profile.id}`, 8, 60 * 60))) return { error: "Za dużo prób zmiany hasła. Spróbuj za godzinę." };
  const db = createAdminClient();
  const { data: user } = await db.auth.admin.getUserById(profile.id).catch(() => ({ data: null }));
  const email = user?.user?.email ?? profile.email;
  if (!email) return { error: "Nie znaleziono konta." };
  const check = createPlainClient(supabaseUrl(), process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const first = !!profile.must_change_password;
  if (!first) {
    // Zwykła zmiana: najpierw obecne hasło – przejęta sesja nie wystarczy do zmiany.
    const current = String(fd.get("current") ?? "");
    const { error: wrong } = current ? await check.auth.signInWithPassword({ email, password: current }) : { error: true };
    if (wrong) {
      await securityEvent("password_change_wrong_current", email);
      return { error: "Obecne hasło jest nieprawidłowe." };
    }
    await check.auth.signOut({ scope: "local" }).catch(() => null);
  }
  // Nowe hasło nie może być tym samym co dotychczasowe (np. startowe z e-maila).
  const { error: same } = await check.auth.signInWithPassword({ email, password });
  if (!same) {
    await check.auth.signOut({ scope: "local" }).catch(() => null);
    return { error: first ? "Nowe hasło musi być inne niż hasło tymczasowe." : "Nowe hasło musi być inne niż obecne." };
  }
  const { error } = await db.auth.admin.updateUserById(profile.id, { password });
  if (error) return { error: error.message };
  await db.from("profiles").update({ must_change_password: false }).eq("id", profile.id);
  // Komisant na tym samym koncie – też już nie musi zmieniać hasła.
  await db.from("consignors").update({ must_change_password: false }).eq("user_id", profile.id).then(() => null, () => null);
  forgetProfile();
  redirect("/magazyn?ok=" + encodeURIComponent("Hasło ustawione. Od teraz logujesz się nowym hasłem."));
}
