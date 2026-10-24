import { type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ensureContractPdf } from "@/lib/contracts/store";
import { clientIp, rateLimit } from "@/lib/security";
import { pdfExpired } from "../../pdf-expiry";

export const dynamic = "force-dynamic";

/** Pobranie podpisanej umowy przez sprzedającego (ten sam tajny link). */
export async function GET(_: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[a-f0-9]{32,64}$/.test(token)) return new Response("Nie znaleziono", { status: 404 });
  if (!(await rateLimit(`podpis-pdf:${await clientIp()}`, 120, 600))) return new Response("Za dużo prób – spróbuj za kilka minut.", { status: 429 });
  const db = createAdminClient();
  const { data: c } = await db.from("contracts").select("id, number, status, accepted_at").eq("sign_token", token).maybeSingle();
  if (!c || c.status !== "accepted") return new Response("Umowa nie jest jeszcze zatwierdzona", { status: 404 });
  if (pdfExpired(c.accepted_at as string | null)) return new Response("Link do pobrania wygasł (ochrona danych). Po kopię umowy napisz do nas.", { status: 410, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  const pdf = await ensureContractPdf(c.id).catch(() => null);
  if (!pdf) return new Response("Nie udało się przygotować PDF – napisz do nas", { status: 500 });
  return new Response(new Uint8Array(pdf), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="umowa-kupna-NR${c.number}.pdf"`, "Cache-Control": "private, no-store" },
  });
}
