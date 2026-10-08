import "server-only";
import nodemailer from "nodemailer";

/** Wysyłka e-maili przez SMTP (np. OVH: ssl0.ovh.net, port 465). Bez konfiguracji – null. */
export function mailConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

export async function sendMail(to: string, subject: string, html: string, attachments?: { filename: string; content: Buffer }[]) {
  if (!mailConfigured()) throw new Error("Brak ustawień SMTP (SMTP_HOST, SMTP_USER, SMTP_PASS) w Vercel");
  const port = Number(process.env.SMTP_PORT ?? 465);
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await transport.sendMail({ from: process.env.SMTP_FROM ?? process.env.SMTP_USER, to, subject, html, attachments });
}
