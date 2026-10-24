"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { clientIp, rateLimit, rateLimitReset, securityEvent } from "@/lib/security";

const TOO_MANY = { error: "Za dużo prób logowania. Odczekaj 15 minut i spróbuj ponownie." };

export async function signIn(_: unknown, formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/magazyn");
  if (!email || !password || email.length > 200 || password.length > 200) return { error: "Nieprawidłowy e-mail lub hasło." };
  // Limity prób: z jednego adresu IP i na jedno konto (ochrona przed zgadywaniem haseł).
  const ip = await clientIp();
  // Konto + IP: obcy z innego adresu nie zablokuje logowania pracownikowi. Luźniejszy limit na samo konto
  // zatrzymuje zgadywanie hasła z wielu adresów naraz.
  const emailKey = `login:email:${email.toLowerCase()}:${ip}`;
  const [ipOk, emailOk, accountOk] = await Promise.all([
    rateLimit(`login:ip:${ip}`, 30, 15 * 60),
    rateLimit(emailKey, 8, 15 * 60),
    rateLimit(`login:konto:${email.toLowerCase()}`, 40, 15 * 60),
  ]);
  if (!ipOk || !emailOk || !accountOk) {
    await securityEvent("login_blocked", email, { by: !ipOk ? "ip" : !emailOk ? "konto+ip" : "konto" });
    return TOO_MANY;
  }
  const supabase = await createClient();
  const { data: signed, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    await securityEvent("login_failed", email, { code: error.code ?? null });
    if (error.status === 429 || error.code === "over_request_rate_limit") return TOO_MANY;
    // Konkretny powód ułatwia ustawienie konta i kluczy (np. błędny klucz Supabase w Vercel).
    // Ten sam komunikat dla złego hasła i niepotwierdzonego konta – bez zdradzania, czy konto istnieje.
    if (error.code === "invalid_credentials" || error.code === "email_not_confirmed" || (!error.code && error.status === 400)) return { error: "Nieprawidłowy e-mail lub hasło." };
    return { error: `Logowanie nie działa (${error.code ?? error.status ?? "błąd"}). Spróbuj ponownie za chwilę.` };
  }
  await rateLimitReset(emailKey);
  // Komisant trafia do swojego panelu (pracownik, który jest też komisantem – do aplikacji; panel ma w menu).
  if (signed?.user) {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const admin = createAdminClient();
    const [{ data: consignor }, { data: staff }] = await Promise.all([
      admin.from("consignors").select("id").eq("user_id", signed.user.id).maybeSingle(),
      admin.from("profiles").select("active").eq("id", signed.user.id).maybeSingle(),
    ]);
    if (consignor && !staff?.active) redirect(safeNext(next).startsWith("/komis") ? safeNext(next) : "/komis");
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
