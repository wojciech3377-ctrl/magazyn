import { createServerClient } from "@supabase/ssr";
import { supabaseUrl } from "@/lib/supabase/url";
import { NextResponse, type NextRequest } from "next/server";

/** Nagłówek z id osoby sprawdzonej w proxy (czyta go lib/auth.ts). */
const USER_HEADER = "x-magazyn-uid";

const PUBLIC_PATHS = ["/login", "/manifest.webmanifest", "/api/shopify/webhook", "/api/cron", "/api/drukarka/", "/podpis", "/umowa/"];

/**
 * Content Security Policy z jednorazowym nonce dla każdej strony: przeglądarka uruchamia tylko skrypty
 * aplikacji (z tym nonce), więc wstrzyknięty kod (XSS) się nie wykona. Ramki tylko z tej domeny
 * (wydruk PDF), formularze tylko do tej domeny, połączenia tylko z aplikacją i Supabase (wgrywanie plików).
 */
function contentSecurityPolicy(nonce: string, https: boolean) {
  const dev = process.env.NODE_ENV === "development";
  const supabase = supabaseUrl();
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: https:${supabase.startsWith("http:") ? ` ${supabase}` : ""}`,
    "font-src 'self' data:",
    `connect-src 'self'${supabase.startsWith("http") ? ` ${supabase}` : ""}${dev ? " ws: http://localhost:*" : ""}`,
    "media-src 'self' blob:",
    "frame-src 'self' blob: data:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    ...(https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

/** Ciasteczka sesji niedostępne dla JavaScriptu (kradzież sesji przez XSS niemożliwa). */
const hardened = <T extends object | undefined>(options: T) => ({ ...(options ?? {}), httpOnly: true, sameSite: "lax" as const });

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const isPage = !path.startsWith("/api/");
  const nonce = isPage ? Buffer.from(crypto.randomUUID()).toString("base64") : "";
  const csp = isPage ? contentSecurityPolicy(nonce, request.nextUrl.protocol === "https:") : "";

  // Nagłówki zapytania z nonce – Next.js dodaje go do swoich skryptów podczas renderowania.
  // Zalogowana osoba sprawdzona tutaj trafia do strony nagłówkiem USER_HEADER (strona nie sprawdza tokenu drugi raz).
  // Nagłówek z przeglądarki jest zawsze usuwany – ustawia go tylko proxy po weryfikacji.
  const forward = (userId?: string) => {
    const h = new Headers(request.headers);
    h.delete(USER_HEADER);
    if (userId) h.set(USER_HEADER, userId);
    if (isPage) {
      h.set("x-nonce", nonce);
      h.set("Content-Security-Policy", csp);
    }
    return NextResponse.next({ request: { headers: h } });
  };
  const finish = (res: NextResponse) => {
    if (isPage) res.headers.set("Content-Security-Policy", csp);
    return res;
  };

  let response = forward();
  if (PUBLIC_PATHS.some((p) => path.startsWith(p))) return finish(response);

  const refreshed: { name: string; value: string; options?: object }[] = [];
  const supabase = createServerClient(
    supabaseUrl(),
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          refreshed.push(...cookiesToSet);
        },
      },
    },
  );

  const { data } = await supabase.auth.getClaims();
  const userId = typeof data?.claims?.sub === "string" ? data.claims.sub : "";
  if (!userId) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = path === "/" ? "" : `?next=${encodeURIComponent(path + request.nextUrl.search)}`;
    return finish(NextResponse.redirect(url));
  }
  response = forward(userId);
  refreshed.forEach(({ name, value, options }) => response.cookies.set(name, value, hardened(options)));
  return finish(response);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|svg|ico)$).*)"],
};
