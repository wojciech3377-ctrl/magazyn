import type { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await createClient();
  const { data: auth } = await db.auth.getClaims();
  if (!auth?.claims?.sub) return new Response("unauthorized", { status: 401 });
  const { data: inv } = await db.from("invoices").select("number, xml").eq("id", id).maybeSingle();
  if (!inv?.xml) return new Response("Nie znaleziono", { status: 404 });
  return new Response(inv.xml, {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Content-Disposition": `attachment; filename="${inv.number.replace(/\//g, "-")}.xml"`, "Cache-Control": "private, no-store" },
  });
}
