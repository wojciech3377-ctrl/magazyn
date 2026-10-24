import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { contractPdf } from "@/lib/contracts/sign";
import { can } from "@/lib/permissions";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * Otwiera dokument umowy: wgrany skan albo PDF umowy z szablonu (podpisany lub szkic).
 * Gdy nie ma czego pokazać albo brak dostępu do cen – przechodzi na stronę umowy.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await createClient();
  const { data: auth } = await db.auth.getClaims();
  if (!auth?.claims?.sub) return new Response("unauthorized", { status: 401 });
  const contractPage = NextResponse.redirect(new URL(`/umowy/${id}`, req.url));
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Nie znaleziono", { status: 404 });
  const { data: profile } = await db.from("profiles").select("can_see_prices, active, role, permissions").eq("id", auth.claims.sub).single();
  // Umowy mają dane osobowe sprzedających – tylko działy, które z nimi pracują (nie np. sama Kasa).
  if (!profile?.active || !(["umowy", "magazyn", "dostawa", "sprzedaz", "faktury", "komisanci"] as const).some((s) => can(profile, s))) {
    return new Response("Brak dostępu do umów.", { status: 403 });
  }
  const { data: c } = await db.from("contracts").select("*").eq("id", id).maybeSingle();
  if (!c) return new Response("Nie znaleziono", { status: 404 });

  // Umowy (szablon i skany) zawierają ceny zakupu – plik tylko dla osób z dostępem do cen.
  if (!profile.can_see_prices) return contractPage;
  if (c.file_path) {
    const { data } = await createAdminClient().storage.from("contracts").createSignedUrl(c.file_path, 300);
    if (data?.signedUrl) return NextResponse.redirect(data.signedUrl);
  }
  if (!c.template) return contractPage;
  const pdf = await contractPdf(db, c);
  return new Response(Buffer.from(pdf), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="umowa-NR${c.number}.pdf"`, "Cache-Control": "private, no-store" },
  });
}
