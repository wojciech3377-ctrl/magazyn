import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { contractPdf } from "@/lib/contracts/sign";

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
  const { data: c } = await db.from("contracts").select("*").eq("id", id).maybeSingle();
  if (!c) return new Response("Nie znaleziono", { status: 404 });

  // Umowa z szablonu zawiera ceny zakupu – tylko dla osób z dostępem do cen.
  if (c.template) {
    const { data: profile } = await db.from("profiles").select("can_see_prices").eq("id", auth.claims.sub).single();
    if (!profile?.can_see_prices) return contractPage;
  }
  if (c.file_path) {
    const { data } = await db.storage.from("contracts").createSignedUrl(c.file_path, 300);
    if (data?.signedUrl) return NextResponse.redirect(data.signedUrl);
  }
  if (!c.template) return contractPage;
  const pdf = await contractPdf(db, c);
  return new Response(Buffer.from(pdf), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="umowa-${c.number}.pdf"`, "Cache-Control": "private, no-store" },
  });
}
