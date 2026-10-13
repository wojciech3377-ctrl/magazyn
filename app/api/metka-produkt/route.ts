import { NextResponse, type NextRequest } from "next/server";
import { requireSection } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { productPriceTags } from "@/lib/price-tag";
import { renderPriceTags } from "@/lib/price-tag-pdf";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** PDF z metkami produktów (jedna metka na produkt, bez rozmiaru, kod PR…). ?ids=<produkty>&sklep=<id sklepu>. */
export async function GET(req: NextRequest) {
  await requireSection("magazyn", "kasa", "katalog");
  const sp = req.nextUrl.searchParams;
  const ids = sp.getAll("ids").flatMap((x) => x.split(",")).map((x) => x.trim()).filter((x) => /^[0-9a-f-]{36}$/.test(x)).slice(0, 200);
  const store = sp.get("sklep") ?? "";
  if (!ids.length) return NextResponse.json({ error: "Nie wybrano produktów." }, { status: 400 });
  if (!/^[0-9a-f-]{36}$/.test(store)) return NextResponse.json({ error: "Wybierz sklep." }, { status: 400 });
  const tags = await productPriceTags(createAdminClient(), ids, store);
  if (!tags.length) return NextResponse.json({ error: "Brak produktów do metek (sprawdź migrację 0049)." }, { status: 400 });
  const pdf = await renderPriceTags(tags);
  return new NextResponse(Buffer.from(pdf), {
    headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="metki-produktow-${tags.length}.pdf"`, "cache-control": "no-store" },
  });
}
