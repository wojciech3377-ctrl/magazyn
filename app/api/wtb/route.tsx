import type { NextRequest } from "next/server";
import { requireProfile } from "@/lib/auth";
import { imageData, renderWtbSheet, wtbPages } from "@/lib/wtb";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const UUID = /^[0-9a-f-]{36}$/i;

/** Grafika WTB z wybranych pozycji (ids=…) albo całej aktywnej listy; strona=N przy więcej niż 16 butach. */
export async function GET(req: NextRequest) {
  const { supabase } = await requireProfile();
  const sp = req.nextUrl.searchParams;
  const ids = (sp.get("ids") ?? "").split(",").filter((x) => UUID.test(x)).slice(0, 200);
  let query = supabase.from("wtb_items").select("id, title, size, sku, image_url, created_at");
  query = ids.length ? query.in("id", ids) : query.eq("status", "active");
  const { data } = await query.order("created_at");
  const rows = ids.length ? ids.map((id) => data?.find((d) => d.id === id)).filter((x): x is NonNullable<typeof x> => !!x) : data ?? [];
  if (!rows.length) return new Response("Lista WTB jest pusta", { status: 404 });

  const pages = wtbPages(rows);
  const page = Math.min(pages.length, Math.max(1, Number(sp.get("strona") ?? 1)));
  const items = pages[page - 1];
  const width = items.length === 1 ? 1200 : items.length <= 4 ? 700 : 450;
  const imgs = await Promise.all(items.map((it) => imageData(it.image_url, width)));
  return renderWtbSheet(
    items.map((it, i) => ({ title: it.title, size: it.size, sku: it.sku, image: it.image_url, img: imgs[i] })),
    { page, pages: pages.length, download: sp.get("pobierz") === "1" },
  );
}
