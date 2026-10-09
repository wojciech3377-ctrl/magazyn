import type { NextRequest } from "next/server";
import { requireProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getLabel } from "@/lib/integrations/furgonetka";
import { errorMessage } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** Etykieta przesyłki (PDF) pobierana na żądanie z Furgonetki. */
export async function GET(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase } = await requireProfile();
  const { data: s } = await supabase.from("shipments").select("external_id, tracking_number").eq("id", id).maybeSingle();
  if (!s) return new Response("Nie ma takiej przesyłki", { status: 404 });
  try {
    const pdf = await getLabel(createAdminClient(), s.external_id);
    return new Response(Buffer.from(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="etykieta-${s.tracking_number ?? s.external_id}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    return new Response(errorMessage(e), { status: 502, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}
