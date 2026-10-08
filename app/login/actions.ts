"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function signIn(_: unknown, formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/magazyn");
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    // Konkretny powód ułatwia ustawienie konta i kluczy (np. błędny klucz Supabase w Vercel).
    if (error.code === "invalid_credentials") return { error: "Nieprawidłowy e-mail lub hasło." };
    if (error.code === "email_not_confirmed") return { error: "Konto nie jest potwierdzone. W Supabase → Authentication → Users potwierdź je albo dodaj ponownie z „Auto Confirm User”." };
    return { error: `Logowanie nie działa: ${error.message}${error.code ? ` (${error.code})` : ""}. Sprawdź adres i klucz Supabase w Vercel.` };
  }
  redirect(safeNext(next));
}

/** Tylko ścieżki w tej aplikacji (bez przekierowań na obce domeny, także przez „/\\”). */
function safeNext(next: string) {
  try {
    const base = new URL("https://app.local");
    const url = new URL(next, base);
    return url.origin === base.origin && next.startsWith("/") ? url.pathname + url.search : "/magazyn";
  } catch {
    return "/magazyn";
  }
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
