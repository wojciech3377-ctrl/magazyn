"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { errorMessage } from "@/lib/errors";
import type { LineItem } from "@/lib/sync/shop-orders";

export type WtbAddState = { ok?: string; error?: string } | null;
export type CatalogResult = { productId: string; title: string; sku: string | null; image: string | null; variants: { id: string; option: string }[] };

const collator = new Intl.Collator("pl", { numeric: true });

/** Wyszukiwarka modeli z katalogu (nazwa albo SKU). */
export async function searchWtbCatalog(q: string): Promise<CatalogResult[]> {
  const { supabase } = await requireProfile();
  const text = q.trim().replace(/[,()*%\\]/g, " ").trim().slice(0, 60);
  if (text.length < 2) return [];
  const fields = "id, title, style_sku, image_url, variants(id, option)";
  let query = supabase.from("products").select(fields).limit(12);
  for (const w of text.split(/\s+/).filter(Boolean).slice(0, 4)) query = query.ilike("title", `%${w}%`);
  let { data } = await query;
  if (!data?.length) ({ data } = await supabase.from("products").select(fields).ilike("style_sku", `%${text}%`).limit(12));
  return (data ?? []).map((p) => ({
    productId: p.id as string,
    title: p.title as string,
    sku: (p.style_sku as string | null) ?? null,
    image: (p.image_url as string | null) ?? null,
    variants: ((p.variants ?? []) as { id: string; option: string }[]).sort((a, b) => collator.compare(a.option, b.option)),
  }));
}

/** „Dodaj do WTB” przy pozycji zamówienia albo linii sprzedaży. */
export async function addToWtb(_: WtbAddState, fd: FormData): Promise<WtbAddState> {
  const { supabase, profile } = await requireProfile();
  const orderId = String(fd.get("order_id") ?? "");
  const saleId = String(fd.get("sale_id") ?? "");
  try {
    if (orderId) {
      const lineIdx = Number(fd.get("line") ?? -1);
      const { data: order } = await supabase.from("orders").select("id, name, line_items").eq("id", orderId).maybeSingle();
      const line = ((order?.line_items ?? []) as LineItem[])[lineIdx];
      if (!order || !line) return { error: "Nie ma takiej pozycji." };
      const { data: existing } = await supabase.from("wtb_items").select("id").eq("order_id", order.id).eq("order_line_id", line.id).eq("status", "active").maybeSingle();
      if (existing) return { ok: "Już jest na liście WTB." };
      const { data: link } = line.shopify_variant_id
        ? await supabase.from("variant_store_links").select("variant_id, variant:variants(product_id, product:products(image_url, style_sku))").eq("shopify_variant_id", line.shopify_variant_id).maybeSingle()
        : { data: null };
      const v = link?.variant as unknown as { product_id: string; product: { image_url: string | null; style_sku: string | null } } | null;
      const { error } = await supabase.from("wtb_items").insert({
        title: line.title, size: line.variant_title, sku: line.sku ?? v?.product.style_sku ?? null, image_url: line.image ?? v?.product.image_url ?? null,
        variant_id: link?.variant_id ?? null, product_id: v?.product_id ?? null,
        source: "order", order_id: order.id, order_line_id: line.id, note: `z zamówienia ${order.name}`, created_by: profile.id,
      });
      if (error) {
        if (error.code === "23505") return { ok: "Już jest na liście WTB." };
        throw error;
      }
    } else if (saleId) {
      const { data: sale } = await supabase.from("sales").select("id, order_ref, variant_id, variant:variants(option, product:products(id, title, image_url, style_sku))").eq("id", saleId).maybeSingle();
      const v = sale?.variant as unknown as { option: string; product: { id: string; title: string; image_url: string | null; style_sku: string | null } } | null;
      if (!sale || !v) return { error: "Ta linia nie ma produktu z katalogu." };
      const { error } = await supabase.from("wtb_items").insert({
        title: v.product.title, size: v.option, sku: v.product.style_sku, image_url: v.product.image_url,
        variant_id: sale.variant_id, product_id: v.product.id, source: "sale", note: sale.order_ref ? `z zamówienia ${sale.order_ref}` : null, created_by: profile.id,
      });
      if (error) throw error;
    } else {
      return { error: "Brak pozycji." };
    }
  } catch (e) {
    return { error: errorMessage(e) };
  }
  revalidatePath("/wtb");
  return { ok: "Dodano do WTB." };
}

/** Dodanie modelu z katalogu w kilku rozmiarach naraz. */
export async function addFromCatalog(_: WtbAddState, fd: FormData): Promise<WtbAddState> {
  const { supabase, profile } = await requireProfile();
  const productId = String(fd.get("product_id") ?? "");
  const variantIds = fd.getAll("variant_id").map(String).filter(Boolean);
  const note = String(fd.get("note") ?? "").trim() || null;
  const { data: p } = await supabase.from("products").select("id, title, image_url, style_sku, variants(id, option)").eq("id", productId).maybeSingle();
  if (!p) return { error: "Wybierz model z katalogu." };
  const variants = ((p.variants ?? []) as { id: string; option: string }[]).filter((v) => variantIds.includes(v.id));
  const rows = (variants.length ? variants : [null]).map((v) => ({
    title: p.title, size: v?.option ?? null, sku: p.style_sku, image_url: p.image_url, product_id: p.id, variant_id: v?.id ?? null,
    source: "catalog", note, created_by: profile.id,
  }));
  const { error } = await supabase.from("wtb_items").insert(rows);
  if (error) return { error: errorMessage(error) };
  revalidatePath("/wtb");
  return { ok: rows.length === 1 ? "Dodano do WTB." : `Dodano ${rows.length} pozycji do WTB.` };
}

/** Pozycja wpisana ręcznie (spoza katalogu). */
export async function addManual(_: WtbAddState, fd: FormData): Promise<WtbAddState> {
  const { supabase, profile } = await requireProfile();
  const title = String(fd.get("title") ?? "").trim().slice(0, 200);
  if (!title) return { error: "Wpisz nazwę modelu." };
  const sizes = String(fd.get("sizes") ?? "").split(/[,;]+/).map((s) => s.trim()).filter(Boolean).slice(0, 30);
  const sku = String(fd.get("sku") ?? "").trim().slice(0, 60) || null;
  const note = String(fd.get("note") ?? "").trim() || null;
  const rows = (sizes.length ? sizes : [null]).map((size) => ({ title, size, sku, note, source: "manual", created_by: profile.id }));
  const { error } = await supabase.from("wtb_items").insert(rows);
  if (error) return { error: errorMessage(error) };
  revalidatePath("/wtb");
  return { ok: rows.length === 1 ? "Dodano do WTB." : `Dodano ${rows.length} pozycji do WTB.` };
}

/** Zmiana stanu zaznaczonych pozycji: kupione / usunięte / z powrotem na liście. */
export async function updateWtb(fd: FormData) {
  const { supabase } = await requireProfile();
  const ids = fd.getAll("ids").map(String).filter(Boolean);
  const to = String(fd.get("to") ?? "");
  const back = String(fd.get("back") ?? "/wtb");
  if (!ids.length) redirect(`${back}${back.includes("?") ? "&" : "?"}blad=${encodeURIComponent("Zaznacz pozycje.")}`);
  if (!["bought", "cancelled", "active"].includes(to)) redirect(back);
  const { error } = await supabase.from("wtb_items").update({ status: to, closed_at: to === "active" ? null : new Date().toISOString() }).in("id", ids);
  const msg = error ? errorMessage(error) : to === "bought" ? "Oznaczone jako kupione." : to === "cancelled" ? "Usunięte z listy." : "Wróciło na listę.";
  revalidatePath("/wtb");
  redirect(`${back}${back.includes("?") ? "&" : "?"}${error ? "blad" : "ok"}=${encodeURIComponent(msg)}`);
}
