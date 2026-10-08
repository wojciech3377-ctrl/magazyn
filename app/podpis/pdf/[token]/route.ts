import { type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** Pobranie podpisanej umowy przez sprzedającego (ten sam tajny link). */
export async function GET(_: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[a-f0-9]{32,64}$/.test(token)) return new Response("Nie znaleziono", { status: 404 });
  const db = createAdminClient();
  const { data: c } = await db.from("contracts").select("number, status, file_path").eq("sign_token", token).maybeSingle();
  if (!c || c.status !== "signed" || !c.file_path) return new Response("Umowa nie jest jeszcze gotowa", { status: 404 });
  const { data: file } = await db.storage.from("contracts").download(c.file_path);
  if (!file) return new Response("Nie znaleziono pliku", { status: 404 });
  return new Response(await file.arrayBuffer(), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="umowa-kupna-${c.number}.pdf"`, "Cache-Control": "private, no-store" },
  });
}
