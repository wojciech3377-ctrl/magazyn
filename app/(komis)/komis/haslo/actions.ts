"use server";

import { redirect } from "next/navigation";
import { requireConsignor } from "@/lib/consignment";

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
  const { error } = await db.auth.admin.updateUserById(userId, { password });
  if (error) return { error: /same|different|reuse/i.test(error.message) ? "Nowe hasło musi być inne niż hasło startowe." : error.message };
  await db.from("consignors").update({ must_change_password: false }).eq("id", consignor.id);
  redirect("/komis?ok=" + encodeURIComponent("Hasło ustawione. Od teraz logujesz się nowym hasłem."));
}
