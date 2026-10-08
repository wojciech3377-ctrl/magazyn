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
