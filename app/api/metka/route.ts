import { NextResponse, type NextRequest } from "next/server";
import { requireProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { priceTags } from "@/lib/price-tag";
import { renderPriceTags } from "@/lib/price-tag-pdf";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** PDF z metkami 57 × 32 mm (strona = metka). ?ids=… , opcjonalnie ?stan=nowe|uzywane. */
export async function GET(req: NextRequest) {
  await requireProfile();
  const sp = req.nextUrl.searchParams;
  const ids = sp.getAll("ids").flatMap((x) => x.split(",")).map((x) => x.trim()).filter((x) => /^[0-9a-f-]{36}$/.test(x)).slice(0, 200);
  if (!ids.length) return NextResponse.json({ error: "Nie wybrano sztuk." }, { status: 400 });
  let tags = await priceTags(createAdminClient(), ids);
  const stan = sp.get("stan");
  if (stan === "nowe") tags = tags.filter((t) => !t.used);
  if (stan === "uzywane") tags = tags.filter((t) => t.used);
  const pdf = await renderPriceTags(tags);
  return new NextResponse(Buffer.from(pdf), {
    headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="metki-${tags.length}.pdf"`, "cache-control": "no-store" },
  });
}
