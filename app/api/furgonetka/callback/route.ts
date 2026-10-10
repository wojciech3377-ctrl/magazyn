import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { requireProfile } from "@/lib/auth";
import { appUrl } from "@/lib/app-url";
import { createAdminClient } from "@/lib/supabase/admin";
import { exchangeCode } from "@/lib/integrations/furgonetka";
import { errorMessage } from "@/lib/errors";

export const dynamic = "force-dynamic";

function sameState(a: string | undefined, b: string | null) {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Powrót z logowania Furgonetki: wymiana kodu na tokeny (kod jest ważny 30 s). */
export async function GET(req: NextRequest) {
  const { profile } = await requireProfile();
  const base = await appUrl();
  const back = (msg: string, ok: boolean) => {
    const res = NextResponse.redirect(`${base}/ustawienia?zakladka=wysylka&${ok ? "ok" : "blad"}=${encodeURIComponent(msg)}`);
    res.cookies.delete({ name: "furgonetka_state", path: "/api/furgonetka" });
    return res;
  };
  if (profile.role !== "admin") return back("Tylko administrator może połączyć Furgonetkę.", false);
  const sp = req.nextUrl.searchParams;
  if (sp.get("error")) return back(`Furgonetka: ${sp.get("error_description") ?? sp.get("error")}`, false);
  if (!sameState(req.cookies.get("furgonetka_state")?.value, sp.get("state"))) return back("Połączenie wygasło – kliknij „Połącz z Furgonetką” jeszcze raz.", false);
  const code = sp.get("code");
  if (!code) return back("Furgonetka nie zwróciła kodu.", false);
  try {
    await exchangeCode(createAdminClient(), code, `${base}/api/furgonetka/callback`, profile.id);
  } catch (e) {
    return back(errorMessage(e), false);
  }
  return back("Furgonetka połączona.", true);
}
