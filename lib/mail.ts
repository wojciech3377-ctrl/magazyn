import "server-only";
import nodemailer from "nodemailer";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Wysyłka e-maili przez SMTP. Ustawienia z aplikacji (Ustawienia → Faktury: serwer, login, nadawca; hasło
 * w Supabase Vault) mają pierwszeństwo; bez nich – zmienne SMTP_* w Vercel.
 */
export type MailConfig = { host: string; port: number; user: string; pass: string; from: string; source: "app" | "env" };
export type SmtpSettings = { host?: string; port?: number; user?: string; from_email?: string; from_name?: string };

let cache: { cfg: MailConfig | null; at: number } | null = null;

export async function getSmtpSettings(): Promise<SmtpSettings> {
  const { data } = await createAdminClient().from("app_settings").select("value").eq("key", "smtp").maybeSingle();
  return (data?.value as SmtpSettings | null) ?? {};
}

export function clearMailCache() {
  cache = null;
}

export async function mailConfig(): Promise<MailConfig | null> {
  if (cache && Date.now() - cache.at < 60_000) return cache.cfg;
  let cfg: MailConfig | null = null;
  try {
    const s = await getSmtpSettings();
    if (s.host && s.user) {
      const { data: pass } = await createAdminClient().rpc("smtp_password_get");
      if (pass) {
        const address = s.from_email || s.user;
        cfg = { host: s.host, port: Number(s.port || 465), user: s.user, pass: pass as string, from: s.from_name ? `"${s.from_name.replace(/"/g, "")}" <${address}>` : address, source: "app" };
      }
    }
  } catch {
    // brak tabeli / funkcji (przed migracją) – zostają zmienne z Vercel
  }
  if (!cfg && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    cfg = {
      host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT ?? 465), user: process.env.SMTP_USER, pass: process.env.SMTP_PASS,
      from: process.env.SMTP_FROM ?? process.env.SMTP_USER, source: "env",
    };
  }
  cache = { cfg, at: Date.now() };
  return cfg;
}

export async function mailConfigured() {
  return !!(await mailConfig());
}

export async function sendMail(to: string, subject: string, html: string, attachments?: { filename: string; content: Buffer }[]) {
  const cfg = await mailConfig();
  if (!cfg) throw new Error("Wysyłka e-maili nie jest ustawiona (Ustawienia → Faktury i KSeF → Wysyłka e-maili)");
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
  });
  await transport.sendMail({ from: cfg.from, to, subject, html, attachments });
}
