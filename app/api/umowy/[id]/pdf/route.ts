import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { contractPdf } from "@/lib/contracts/sign";

export const dynamic = "force-dynamic";

/** PDF umowy dla pracownika: podpisany plik albo szkic do podglądu przed podpisem. */
export async function GET(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await createClient();
  const { data: auth } = await db.auth.getClaims();
  if (!auth?.claims?.sub) return new Response("unauthorized", { status: 401 });
  // Umowa zawiera ceny zakupu – tylko dla osób z dostępem do cen.
  const { data: profile } = await db.from("profiles").select("can_see_prices, active").eq("id", auth.claims.sub).single();
  if (!profile?.active || !profile.can_see_prices) return new Response("Brak dostępu do cen zakupu", { status: 403 });
  const { data: c } = await db.from("contracts").select("*").eq("id", id).maybeSingle();
  if (!c) return new Response("Nie znaleziono", { status: 404 });
  if (c.file_path) {
    const { data } = await db.storage.from("contracts").createSignedUrl(c.file_path, 300);
    if (data?.signedUrl) return Response.redirect(data.signedUrl, 302);
  }
  if (!c.template) return new Response("Ta umowa nie ma pliku", { status: 404 });
  const pdf = await contractPdf(db, c);
  return new Response(Buffer.from(pdf), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="umowa-${c.number}-szkic.pdf"`, "Cache-Control": "private, no-store" },
  });
}
