import { NextResponse, type NextRequest } from "next/server";
import { requireProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** Plik zadania: tylko dla pracownika, który widzi to zadanie; krótki link z Supabase (60 s). */
export async function GET(req: NextRequest) {
  const { supabase } = await requireProfile();
  const id = req.nextUrl.searchParams.get("zadanie") ?? "";
  const path = req.nextUrl.searchParams.get("plik") ?? "";
  if (!/^[0-9a-f-]{36}$/.test(id) || !/^\d{4}\/\d{2}\/[0-9a-f-]{36}\.[a-z0-9]{1,5}$/.test(path)) return NextResponse.json({ error: "Zły plik." }, { status: 400 });
  const { data: t } = await supabase.from("tasks").select("files").eq("id", id).maybeSingle();
  const file = ((t?.files ?? []) as { path: string; name: string }[]).find((f) => f.path === path);
  if (!file) return NextResponse.json({ error: "Nie ma takiego pliku." }, { status: 404 });
  const inline = /\.(pdf|jpe?g|png|webp|gif)$/i.test(path);
  const { data } = await createAdminClient().storage.from("task-files").createSignedUrl(path, 60, inline ? undefined : { download: file.name });
  if (!data?.signedUrl) return NextResponse.json({ error: "Plik niedostępny." }, { status: 404 });
  return NextResponse.redirect(data.signedUrl);
}
