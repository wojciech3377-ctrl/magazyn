import { headers } from "next/headers";

/**
 * Adres aplikacji do linków dla klientów (podpis umowy itp.): APP_URL z Vercel, potem adres produkcyjny
 * z Vercel. Nagłówka Host używamy tylko lokalnie – na produkcji dałoby się nim podmienić domenę w wysyłanym linku.
 */
export async function appUrl() {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL.replace(/\/$/, "")}`;
  const h = await headers();
  const host = h.get("host") ?? "";
  if (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return `http://${host}`;
  // Ostatecznie – znany adres produkcyjny (nigdy domena z nagłówka zapytania).
  return "https://magazyn-two.vercel.app";
}
