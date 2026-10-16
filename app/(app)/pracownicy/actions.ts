"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { forgetProfile, requireAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { SECTION_KEYS, type Section } from "@/lib/permissions";
import { errorMessage } from "@/lib/errors";

async function done(msg: string, tone: "ok" | "blad" = "ok", open?: string): Promise<never> {
  revalidatePath("/pracownicy");
  redirect(`/pracownicy?${tone}=${encodeURIComponent(msg)}${open ? `&edytuj=${open}` : ""}`);
}

function readPermissions(fd: FormData): Section[] {
  const picked = new Set(fd.getAll("perm").map(String));
  return SECTION_KEYS.filter((k) => picked.has(k));
}

const text = (fd: FormData, k: string, max = 120) => String(fd.get(k) ?? "").trim().slice(0, max) || null;

export type CreateState = { error?: string; ok?: string } | null;

/** Nowy pracownik: konto z hasłem startowym (bez e-maili), rola i działy. */
export async function createEmployee(_: CreateState, fd: FormData): Promise<CreateState> {
  await requireAdmin();
  const email = String(fd.get("email") ?? "").trim().toLowerCase();
  const password = String(fd.get("password") ?? "");
  const role = fd.get("role") === "admin" ? "admin" : "staff";
  const permissions = readPermissions(fd);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "Podaj poprawny e-mail – to login pracownika." };
  if (role === "staff" && !permissions.length) return { error: "Zaznacz co najmniej jeden dział, do którego pracownik ma mieć dostęp." };

  const admin = createAdminClient();
  // Komisant z kontem może zostać też pracownikiem: to samo konto dostaje profil pracownika (hasło bez zmian).
  const { data: cons } = await admin.from("consignors").select("user_id, name").ilike("email", email).not("user_id", "is", null).maybeSingle();
  if (cons?.user_id) {
    const { data: had } = await admin.from("profiles").select("id").eq("id", cons.user_id).maybeSingle();
    if (had) return { error: "Konto z tym e-mailem już jest kontem pracownika." };
    const { error: iErr } = await admin.from("profiles").insert({
      id: cons.user_id, email, full_name: text(fd, "full_name"), phone: text(fd, "phone", 30), role, permissions,
      can_see_prices: fd.get("can_see_prices") !== null, active: true,
    });
    forgetProfile();
    if (iErr) return { error: iErr.message };
    revalidatePath("/pracownicy");
    return { ok: `${email} to konto komisanta ${cons.name} – dostało też dostęp pracownika. Loguje się swoim dotychczasowym hasłem (hasło startowe z formularza nie jest użyte).` };
  }
  if (password.length < 10) return { error: "Hasło startowe musi mieć co najmniej 10 znaków." };
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: text(fd, "full_name") } });
  if (error) return { error: /already|registered|exists/i.test(error.message) ? "Konto z tym e-mailem już istnieje." : error.message };
  const { error: pErr } = await admin.from("profiles").update({
    full_name: text(fd, "full_name"),
    phone: text(fd, "phone", 30),
    role,
    permissions,
    can_see_prices: fd.get("can_see_prices") !== null,
    active: true,
  }).eq("id", data.user.id);
  forgetProfile();
  if (pErr) return { error: `Konto utworzone, ale nie zapisały się uprawnienia: ${pErr.message}. Uruchom migrację 0038.` };
  revalidatePath("/pracownicy");
  return { ok: `Dodano ${email}. Przekaż hasło osobiście – pracownik loguje się e-mailem i tym hasłem.` };
}

/** Zmiana danych, roli, działów i blokady. */
export async function saveEmployee(fd: FormData) {
  const { supabase, profile } = await requireAdmin();
  const id = String(fd.get("id"));
  const role = fd.get("role") === "admin" ? "admin" : "staff";
  const active = fd.get("active") !== null;
  if (id === profile.id && (role !== "admin" || !active)) return done("Nie możesz odebrać sobie roli administratora ani zablokować własnego konta.", "blad", id);
  const permissions = readPermissions(fd);
  if (role === "staff" && active && !permissions.length) return done("Zaznacz co najmniej jeden dział albo zablokuj konto.", "blad", id);
  const { error } = await supabase.from("profiles").update({
    full_name: text(fd, "full_name"),
    phone: text(fd, "phone", 30),
    role,
    permissions,
    can_see_prices: fd.get("can_see_prices") !== null,
    active,
  }).eq("id", id);
  forgetProfile();
  if (error) return done(error.message, "blad", id);
  await done("Zapisano zmiany pracownika.");
}

/** Nowe hasło ustawione przez administratora (np. gdy pracownik zapomniał). */
export async function setEmployeePassword(fd: FormData) {
  await requireAdmin();
  const id = String(fd.get("id"));
  const password = String(fd.get("password") ?? "");
  if (password.length < 10) return done("Hasło musi mieć co najmniej 10 znaków.", "blad", id);
  const { error } = await createAdminClient().auth.admin.updateUserById(id, { password });
  if (error) return done(error.message, "blad", id);
  await done("Ustawiono nowe hasło. Przekaż je pracownikowi osobiście.");
}

/** Usunięcie konta. Gdy pracownik ma już historię (dostawy, umowy, sprzedaże) – zostaje tylko blokada. */
export async function deleteEmployee(fd: FormData) {
  const { profile } = await requireAdmin();
  const id = String(fd.get("id"));
  if (id === profile.id) return done("Nie możesz usunąć własnego konta.", "blad", id);
  const admin = createAdminClient();
  // Pracownik, który jest też komisantem: znika tylko dostęp pracownika, konto zostaje do panelu komisanta.
  const { data: cons } = await admin.from("consignors").select("id").eq("user_id", id).maybeSingle();
  if (cons) {
    const { error } = await admin.from("profiles").delete().eq("id", id);
    forgetProfile();
    if (error) {
      await admin.from("profiles").update({ active: false }).eq("id", id);
      return done("Konto ma historię w aplikacji – dostęp pracownika zablokowany. Panel komisanta działa dalej.", "ok");
    }
    return done("Dostęp pracownika usunięty – konto zostaje jako konto komisanta.", "ok");
  }
  try {
    const { error } = await admin.auth.admin.deleteUser(id);
    forgetProfile();
    if (error) throw error;
  } catch (e) {
    await admin.from("profiles").update({ active: false }).eq("id", id);
    forgetProfile();
    return done(`Konto ma historię w aplikacji, więc zostało zablokowane zamiast usunięte (${errorMessage(e).slice(0, 120)}).`, "ok");
  }
  await done("Konto usunięte.");
}
