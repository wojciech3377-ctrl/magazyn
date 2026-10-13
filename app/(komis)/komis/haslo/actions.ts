"use server";

import { redirect } from "next/navigation";
import { createClient as createPlainClient } from "@supabase/supabase-js";
import { requireConsignor } from "@/lib/consignment";
import { supabaseUrl } from "@/lib/supabase/url";
import { rateLimit, securityEvent } from "@/lib/security";

export type PasswordState = { error?: string } | null;

/** Komisant ustawia własne hasło (pierwsze logowanie albo zmiana z panelu). */
export async function setConsignorPassword(_: PasswordState, fd: FormData): Promise<PasswordState> {
  const { db, consignor } = await requireConsignor({ passwordPage: true });
  const password = String(fd.get("password") ?? "");
  const repeat = String(fd.get("repeat") ?? "");
  if (password.length < 10) return { error: "Hasło musi mieć co najmniej 10 znaków." };
  if (!/[A-Za-ząćęłńóśźżĄĆĘŁŃÓŚŹŻ]/.test(password) || !/\d/.test(password)) return { error: "Hasło musi zawierać litery i cyfry." };
  if (password !== repeat) return { error: "Hasła nie są takie same." };
  const userId = (consignor as { user_id?: string | null }).user_id;
  if (!userId) return { error: "Konto nie jest powiązane z komisantem." };
  if (!(await rateLimit(`password:${userId}`, 8, 60 * 60))) return { error: "Za dużo prób zmiany hasła. Spróbuj za godzinę." };
  // Zwykła zmiana hasła (nie pierwsze logowanie): najpierw obecne hasło – przejęta sesja nie wystarczy do zmiany.
  if (!(consignor as { must_change_password?: boolean }).must_change_password) {
    const current = String(fd.get("current") ?? "");
    const { data: user } = await db.auth.admin.getUserById(userId);
    const email = user?.user?.email;
    const check = createPlainClient(supabaseUrl(), process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error: wrong } = email && current ? await check.auth.signInWithPassword({ email, password: current }) : { error: true };
    if (wrong) {
      await securityEvent("password_change_wrong_current", email ?? userId);
      return { error: "Obecne hasło jest nieprawidłowe." };
    }
    await check.auth.signOut({ scope: "local" }).catch(() => null);
  }
  const { error } = await db.auth.admin.updateUserById(userId, { password });
  if (error) return { error: /same|different|reuse/i.test(error.message) ? "Nowe hasło musi być inne niż hasło startowe." : error.message };
  await db.from("consignors").update({ must_change_password: false }).eq("id", consignor.id);
  redirect("/komis?ok=" + encodeURIComponent("Hasło ustawione. Od teraz logujesz się nowym hasłem."));
}
