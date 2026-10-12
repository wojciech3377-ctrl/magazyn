"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSection } from "@/lib/auth";
import { errorMessage } from "@/lib/errors";
import type { LineItem } from "@/lib/sync/shop-orders";
import { parseSizes } from "@/lib/wtb-group";

export type WtbAddState = { ok?: string; error?: string } | null;
export type CatalogResult = { productId: string; title: string; sku: string | null; image: string | null; variants: { id: string; option: string }[] };

const collator = new Intl.Collator("pl", { numeric: true });

/** Wyszukiwarka modeli z katalogu (nazwa albo SKU). */
export async function searchWtbCatalog(q: string): Promise<CatalogResult[]> {
  const { supabase } = await requireSection("wtb");
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
  const { supabase, profile } = await requireSection("wtb", "sprzedaz");
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

/** „Dodaj do WTB” przy zamówieniu: wszystkie produkty zamówienia (bez usług) na listę WTB, bez duplikatów. */
export async function addOrderToWtb(_: WtbAddState, fd: FormData): Promise<WtbAddState> {
  const { supabase, profile } = await requireSection("wtb", "sprzedaz");
  const orderId = String(fd.get("order_id") ?? "");
  const { data: order } = await supabase.from("orders").select("id, name, line_items").eq("id", orderId).maybeSingle();
  if (!order) return { error: "Nie ma takiego zamówienia." };
  const lines = ((order.line_items ?? []) as LineItem[]).filter((l) => !l.service);
  if (!lines.length) return { error: "Zamówienie nie ma produktów." };
  const { data: existing } = await supabase.from("wtb_items").select("order_line_id").eq("order_id", order.id).eq("status", "active");
  const have = new Set((existing ?? []).map((e) => e.order_line_id as string));
  const todo = lines.filter((l) => !have.has(l.id));
  if (!todo.length) return { ok: "Już w WTB." };
  const gids = todo.map((l) => l.shopify_variant_id).filter((x): x is string => !!x);
  const { data: links } = gids.length
    ? await supabase.from("variant_store_links").select("variant_id, shopify_variant_id, variant:variants(product_id, product:products(image_url, style_sku))").in("shopify_variant_id", gids)
    : { data: [] };
  type L = { variant_id: string; shopify_variant_id: string; variant: { product_id: string; product: { image_url: string | null; style_sku: string | null } } | null };
  const byGid = new Map(((links ?? []) as unknown as L[]).map((l) => [l.shopify_variant_id, l]));
  const rows = todo.map((l) => {
    const k = l.shopify_variant_id ? byGid.get(l.shopify_variant_id) : undefined;
    return {
      title: l.title, size: l.variant_title, sku: l.sku ?? k?.variant?.product.style_sku ?? null, image_url: l.image ?? k?.variant?.product.image_url ?? null,
      variant_id: k?.variant_id ?? null, product_id: k?.variant?.product_id ?? null,
      source: "order", order_id: order.id, order_line_id: l.id, note: `z zamówienia ${order.name}`, created_by: profile.id,
    };
  });
  const { error } = await supabase.from("wtb_items").insert(rows);
  if (error) return { error: errorMessage(error) };
  revalidatePath("/wtb");
  return { ok: rows.length === 1 ? "Dodano do WTB." : `Dodano ${rows.length} produkty do WTB.` };
}

/** Dodanie modelu z katalogu w kilku rozmiarach naraz. */
export async function addFromCatalog(_: WtbAddState, fd: FormData): Promise<WtbAddState> {
  const { supabase, profile } = await requireSection("wtb");
  const productId = String(fd.get("product_id") ?? "");
  const variantIds = fd.getAll("variant_id").map(String).filter(Boolean);
  const note = String(fd.get("note") ?? "").trim() || null;
  const { data: p } = await supabase.from("products").select("id, title, image_url, style_sku, variants(id, option)").eq("id", productId).maybeSingle();
  if (!p) return { error: "Wybierz model z katalogu." };
  // Rozmiary już szukane (aktywne) dla tego modelu nie są dodawane drugi raz – dopisują się do tej samej karty.
  const { data: had } = await supabase.from("wtb_items").select("variant_id").eq("product_id", p.id).eq("status", "active");
  const already = new Set((had ?? []).map((h) => h.variant_id as string | null));
  const variants = ((p.variants ?? []) as { id: string; option: string }[]).filter((v) => variantIds.includes(v.id) && !already.has(v.id));
  if (variantIds.length && !variants.length) return { ok: "Te rozmiary już są na liście WTB." };
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
  const { supabase, profile } = await requireSection("wtb");
  const title = String(fd.get("title") ?? "").trim().slice(0, 200);
  if (!title) return { error: "Wpisz nazwę modelu." };
  const sizes = parseSizes(String(fd.get("sizes") ?? ""));
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
  const { supabase } = await requireSection("wtb");
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

/** Zmiana nazwy, rozmiaru albo SKU pozycji (to trafia na grafikę). */
export async function editWtbItem(fd: FormData) {
  const { supabase } = await requireSection("wtb");
  const id = String(fd.get("id") ?? "");
  const back = String(fd.get("back") ?? "/wtb");
  const title = String(fd.get("title") ?? "").trim().slice(0, 200);
  if (!title) redirect(`${back}${back.includes("?") ? "&" : "?"}blad=${encodeURIComponent("Nazwa nie może być pusta.")}`);
  const { error } = await supabase.from("wtb_items").update({
    title, size: String(fd.get("size") ?? "").trim().slice(0, 40) || null, sku: String(fd.get("sku") ?? "").trim().slice(0, 60) || null,
  }).eq("id", id);
  revalidatePath("/wtb");
  redirect(`${back}${back.includes("?") ? "&" : "?"}${error ? "blad" : "ok"}=${encodeURIComponent(error ? errorMessage(error) : "Zapisano zmiany pozycji.")}`);
}

/** Edycja karty modelu: nazwa i SKU dla wszystkich rozmiarów, lista rozmiarów (nowe dopisane, usunięte zdjęte z listy). */
export async function editWtbGroup(fd: FormData) {
  const { supabase, profile } = await requireSection("wtb");
  const ids = fd.getAll("ids").map(String).filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 100);
  const back = String(fd.get("back") ?? "/wtb");
  const fail = (m: string) => redirect(`${back}${back.includes("?") ? "&" : "?"}blad=${encodeURIComponent(m)}`);
  const title = String(fd.get("title") ?? "").trim().slice(0, 200);
  if (!title) fail("Nazwa nie może być pusta.");
  const sku = String(fd.get("sku") ?? "").trim().slice(0, 60) || null;
  const sizes = parseSizes(String(fd.get("sizes") ?? ""));
  const { data: items } = ids.length ? await supabase.from("wtb_items").select("id, size, product_id, variant_id, image_url, note, source").in("id", ids).eq("status", "active") : { data: [] };
  if (!items?.length) fail("Nie ma takiej pozycji.");
  const list = items ?? [];
  const norm = (s: string | null) => (s ?? "").trim().toLowerCase();
  const wanted = new Set(sizes.map(norm));
  const keep = list.filter((i) => (sizes.length ? wanted.has(norm(i.size as string | null)) : true));
  // Bez rozmiarów: zostaje jedna pozycja bez rozmiaru.
  const remove = sizes.length ? list.filter((i) => !keep.includes(i)) : list.slice(1);
  if (!sizes.length && keep.length) keep.splice(1);
  const haveSizes = new Set(keep.map((i) => norm(i.size as string | null)));
  const add = sizes.filter((s) => !haveSizes.has(norm(s)));
  // Rozmiar zmieniony w miejscu (np. jedna pozycja „42” → „43”), zamiast usuwania i dodawania – zachowuje datę i notatkę.
  while (add.length && remove.length) {
    const r = remove.shift()!;
    await supabase.from("wtb_items").update({ size: add.shift(), variant_id: null }).eq("id", r.id);
  }
  const base = list[0];
  let error = (await supabase.from("wtb_items").update({ title, sku }).in("id", list.map((i) => i.id as string))).error;
  if (!error && remove.length) error = (await supabase.from("wtb_items").update({ status: "cancelled", closed_at: new Date().toISOString() }).in("id", remove.map((i) => i.id as string))).error;
  if (!error && add.length) {
    // Rozmiar z katalogu, gdy model jest w katalogu.
    const { data: vs } = base.product_id ? await supabase.from("variants").select("id, option").eq("product_id", base.product_id) : { data: [] };
    const vOf = new Map((vs ?? []).map((v) => [norm(v.option as string), v.id as string]));
    error = (await supabase.from("wtb_items").insert(add.map((size) => ({
      title, sku, size, image_url: base.image_url, product_id: base.product_id, variant_id: vOf.get(norm(size)) ?? null,
      source: base.source === "manual" ? "manual" : "catalog", note: base.source === "manual" || base.source === "catalog" ? base.note : null, created_by: profile.id,
    })))).error;
  }
  revalidatePath("/wtb");
  redirect(`${back}${back.includes("?") ? "&" : "?"}${error ? "blad" : "ok"}=${encodeURIComponent(error ? errorMessage(error) : "Zapisano zmiany modelu.")}`);
}
