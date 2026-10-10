import { NextResponse } from "next/server";
import { requireProfile } from "@/lib/auth";
import { appUrl } from "@/lib/app-url";
import { authorizeUrl, furgonetkaConfigured, newState } from "@/lib/integrations/furgonetka";

export const dynamic = "force-dynamic";

/** Start połączenia z Furgonetką: przekierowanie na logowanie Furgonetki (tylko administrator). */
export async function GET() {
  const { profile } = await requireProfile();
  const base = await appUrl();
  if (profile.role !== "admin") return NextResponse.redirect(`${base}/ustawienia?zakladka=wysylka&blad=${encodeURIComponent("Tylko administrator może połączyć Furgonetkę.")}`);
  if (!furgonetkaConfigured()) {
    return NextResponse.redirect(`${base}/ustawienia?zakladka=wysylka&blad=${encodeURIComponent("Najpierw dodaj FURGONETKA_CLIENT_ID i FURGONETKA_CLIENT_SECRET w Vercel.")}`);
  }
  const state = newState();
  const res = NextResponse.redirect(authorizeUrl(`${base}/api/furgonetka/callback`, state));
  res.cookies.set("furgonetka_state", state, { httpOnly: true, secure: base.startsWith("https"), sameSite: "lax", maxAge: 600, path: "/api/furgonetka" });
  return res;
}
