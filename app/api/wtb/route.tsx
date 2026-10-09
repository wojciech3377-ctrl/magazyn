import type { NextRequest } from "next/server";
import { requireProfile } from "@/lib/auth";
import type { LineItem } from "@/lib/sync/shop-orders";
import { imageData, renderWtb, type WtbItem } from "@/lib/wtb";

export const dynamic = "force-dynamic";

async function loadItem(req: NextRequest): Promise<WtbItem | null> {
  const { supabase } = await requireProfile();
  const sp = req.nextUrl.searchParams;
  const orderId = sp.get("zamowienie");
  if (orderId) {
    const { data: order } = await supabase.from("orders").select("line_items").eq("id", orderId).maybeSingle();
    const line = ((order?.line_items ?? []) as LineItem[])[Number(sp.get("linia") ?? 0)];
    if (!line) return null;
    let image = line.image;
    let sku = line.sku;
    if ((!image || !sku) && line.shopify_variant_id) {
      const { data: link } = await supabase.from("variant_store_links").select("sku, variant:variants(product:products(image_url, style_sku))").eq("shopify_variant_id", line.shopify_variant_id).maybeSingle();
      const p = (link?.variant as unknown as { product: { image_url: string | null; style_sku: string | null } } | null)?.product;
      image ??= p?.image_url ?? null;
      sku ??= p?.style_sku ?? link?.sku ?? null;
    }
    return { title: line.title, size: line.variant_title, sku, image };
  }
  const saleId = sp.get("sprzedaz");
  if (saleId) {
    const { data: sale } = await supabase.from("sales").select("product_name, variant:variants(option, product:products(title, image_url, style_sku))").eq("id", saleId).maybeSingle();
    const v = sale?.variant as unknown as { option: string; product: { title: string; image_url: string | null; style_sku: string | null } } | null;
    if (!v) return sale ? { title: sale.product_name ?? "", size: null, sku: null, image: null } : null;
    return { title: v.product.title, size: v.option, sku: v.product.style_sku, image: v.product.image_url };
  }
  return null;
}

export async function GET(req: NextRequest) {
  const item = await loadItem(req);
  if (!item) return new Response("Nie znaleziono pozycji", { status: 404 });
  return renderWtb(item, await imageData(item.image), req.nextUrl.searchParams.get("pobierz") === "1");
}
