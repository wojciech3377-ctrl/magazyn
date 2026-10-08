import { headers } from "next/headers";

/** Adres aplikacji do linków dla klientów: APP_URL z Vercel albo adres, pod którym jest otwarta. */
export async function appUrl() {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  return `${host.startsWith("localhost") ? "http" : "https"}://${host}`;
}
