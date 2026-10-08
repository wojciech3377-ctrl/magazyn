"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function signIn(_: unknown, formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/magazyn");
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { error: "Nieprawidłowy e-mail lub hasło." };
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
