import { NextResponse } from "next/server";
import { requireSection } from "@/lib/auth";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * Stan kilku paragonów w kolejce drukarki naraz (jedno zapytanie zamiast osobnego co 2,5 s dla każdego).
 * Zwykłe zapytanie GET – nie blokuje kliknięć w aplikacji tak jak akcje serwera.
 */
export async function GET(req: Request) {
  let supabase;
  try {
    ({ supabase } = await requireSection("sprzedaz", "kasa"));
  } catch {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const ids = [...new Set((new URL(req.url).searchParams.get("ids") ?? "").split(",").filter((x) => UUID.test(x)))].slice(0, 50);
  if (!ids.length) return NextResponse.json([]);
  const { data, error } = await supabase.from("receipt_jobs").select("id, status, receipt_number, error, claimed_at, number").in("id", ids);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? [], { headers: { "Cache-Control": "no-store" } });
}
