"use server";

import { redirect } from "next/navigation";
import { requireSection } from "@/lib/auth";
import { findVariantIds } from "@/lib/queries/units";
import { adjustStock } from "@/lib/stock";
import { createAdminClient } from "@/lib/supabase/admin";
import { enqueuePosReceipt } from "@/lib/fiscal/jobs";
import { errorMessage } from "@/lib/errors";
import { parseProductTagCode } from "@/lib/price-tag-code";
import { createParShippingOrder, readParShipping } from "@/lib/orders/par-order";
import { draftFromPos, issueReceipt } from "@/lib/invoices/service";
import { shopifyGraphql } from "@/lib/integrations/shopify";
import { exclusionName, exclusionVat, isExcluded, loadExclusionRules } from "@/lib/services";

export type PosUnit = {
  id: string;
  code: string;
  identifier: string | null;
  status: string;
  title: string;
  option: string;
  image: string | null;
  location: string;
  owner: string | null;
  price: number | null;
  /** Forma sprzedaży sztuki: vat_23 (23%) albo vat_margin (marża) – domyślna stawka PTU w koszyku. */
  purchaseForm: string;
};

const SELECT = `id, code, identifier, status, owner_type, purchase_form, received_at, variant_id, location_id, consignor:consignors(name),
  location:locations(name, store_id),
  variant:variants(option, links:variant_store_links(store_id, price), product:products(title, image_url))`;

type Row = {
  id: string; code: string; identifier: string | null; status: string; owner_type: string; purchase_form: string; variant_id: string;
  consignor: { name: string } | null;
  location: { name: string; store_id: string };
  variant: { option: string; links: { store_id: string; price: number | null }[]; product: { title: string; image_url: string | null } };
};

function toPos(r: Row, storeId: string): PosUnit {
  const price = r.variant.links.find((l) => l.store_id === storeId && l.price !== null)?.price
    ?? r.variant.links.find((l) => l.price !== null)?.price ?? null;
  return {
    id: r.id, code: r.code, identifier: r.identifier, status: r.status,
    title: r.variant.product.title, option: r.variant.option, image: r.variant.product.image_url,
    location: r.location.name, owner: r.consignor?.name ?? null, price: price !== null ? Number(price) : null,
    purchaseForm: r.purchase_form ?? "vat_margin",
  };
}

export type OwnProduct = { id: string; name: string; price: number | null; ptu: string; track_stock: boolean; stock: number; code: string | null };
const OWN_FIELDS = "id, name, price, ptu, track_stock, stock, code";

/** Własne produkty (np. „Renowacja obuwia”) po nazwie albo kodzie. */
export async function searchOwnProducts(q: string): Promise<OwnProduct[]> {
  const { supabase } = await requireSection("kasa");
  const text = q.trim().replace(/[,()*%\\]/g, " ").trim();
  if (text.length < 2) return [];
  let query = supabase.from("pos_products").select(OWN_FIELDS).eq("active", true).limit(15);
  for (const w of text.split(/\s+/).slice(0, 4)) query = query.ilike("name", `%${w}%`);
  const [{ data: byName }, { data: byCode }] = await Promise.all([query, supabase.from("pos_products").select(OWN_FIELDS).eq("active", true).ilike("code", text).limit(5)]);
  const all = [...(byCode ?? []), ...(byName ?? [])] as OwnProduct[];
  return [...new Map(all.map((p) => [p.id, { ...p, price: p.price === null ? null : Number(p.price) }])).values()];
}

/** inStock – sztuki na stanie razem, here – w lokalizacjach wybranego sklepu (na miejscu). */
export type CatalogSize = { variantId: string; option: string; price: number | null; inStock: number; here: number; sku: string | null };
export type CatalogHit = { productId: string; title: string; image: string | null; sku: string | null; sizes: CatalogSize[] };

/**
 * Wyszukiwarka katalogu w Kasie (ręczne dodawanie): modele ze Shopify po nazwie (wszystkie słowa), SKU albo EAN,
 * z rozmiarami, ceną w wybranym sklepie i liczbą sztuk na stanie.
 */
export async function searchCatalog(q: string, storeId: string, limit = 10): Promise<CatalogHit[]> {
  const { supabase } = await requireSection("kasa");
  const text = q.trim().replace(/[,()*%\\"']/g, " ").replace(/\s+/g, " ").trim();
  if (text.length < 2) return [];
  const max = Math.min(Math.max(limit, 1), 30);
  let byTitle = supabase.from("products").select("id").order("updated_at", { ascending: false }).limit(max);
  for (const w of text.split(" ").slice(0, 6)) byTitle = byTitle.ilike("title", `%${w}%`);
  const [title, style, links, eans] = await Promise.all([
    byTitle,
    supabase.from("products").select("id").ilike("style_sku", `%${text}%`).limit(10),
    supabase.from("variant_store_links").select("variant:variants(product_id)").or(`sku.ilike.%${text}%,base_sku.ilike.%${text}%`).limit(40),
    supabase.from("variants").select("product_id").eq("ean", text).limit(5),
  ]);
  // Najpierw dokładniejsze trafienia (EAN, SKU), potem po nazwie.
  const ids = [...new Set([
    ...(eans.data ?? []).map((v) => v.product_id as string),
    ...(links.data ?? []).map((l) => (l.variant as unknown as { product_id: string } | null)?.product_id).filter((x): x is string => !!x),
    ...(style.data ?? []).map((p) => p.id as string),
    ...(title.data ?? []).map((p) => p.id as string),
  ])].slice(0, max);
  if (!ids.length) return [];
  const { data: products } = await supabase.from("products")
    .select("id, title, image_url, style_sku, variants(id, option, links:variant_store_links(store_id, price, sku))")
    .in("id", ids);
  type P = { id: string; title: string; image_url: string | null; style_sku: string | null; variants: { id: string; option: string; links: { store_id: string; price: number | null; sku: string | null }[] }[] };
  const list = (products ?? []) as unknown as P[];
  const variantIds = list.flatMap((p) => p.variants.map((v) => v.id));
  // Sztuki na stanie: razem i na miejscu (lokalizacje wybranego sklepu).
  const counts = new Map<string, number>();
  const here = new Map<string, number>();
  for (let i = 0; i < variantIds.length; i += 150) {
    for (let from = 0; ; from += 1000) {
      const { data } = await supabase.from("units").select("variant_id, location:locations(store_id)").eq("status", "in_stock")
        .in("variant_id", variantIds.slice(i, i + 150)).order("id").range(from, from + 999);
      for (const r of (data ?? []) as unknown as { variant_id: string; location: { store_id: string } | null }[]) {
        counts.set(r.variant_id, (counts.get(r.variant_id) ?? 0) + 1);
        if (r.location?.store_id === storeId) here.set(r.variant_id, (here.get(r.variant_id) ?? 0) + 1);
      }
      if (!data || data.length < 1000) break;
    }
  }
  const collator = new Intl.Collator("pl", { numeric: true });
  const order = new Map(ids.map((id, i) => [id, i]));
  return list
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .map((p) => ({
      productId: p.id, title: p.title, image: p.image_url, sku: p.style_sku,
      sizes: p.variants.map((v) => {
        const own = v.links.find((l) => l.store_id === storeId);
        const any = own?.price != null ? own : v.links.find((l) => l.price !== null);
        return { variantId: v.id, option: v.option, price: any?.price != null ? Number(any.price) : null, inStock: counts.get(v.id) ?? 0, here: here.get(v.id) ?? 0, sku: own?.sku ?? v.links[0]?.sku ?? null };
      }).sort((x, y) => collator.compare(x.option, y.option)),
    }));
}

/**
 * Produkty spoza magazynu aplikacji – prosto ze Shopify wybranego sklepu, z wariantami do wyboru:
 * wykluczone regułą (np. sznurówki rope) oraz bez śledzenia stanu w Shopify (np. Supreme x Hanes – aplikacja ich nie liczy).
 */
export type ExtraSize = { id: string; option: string; price: number | null; available: number | null };
export type ExtraHit = { id: string; title: string; image: string | null; vat: "margin" | "23"; sizes: ExtraSize[]; receiptName?: string | null };

const extraCache = new Map<string, { at: number; hits: ExtraHit[] }>();

export async function searchShopifyExtras(q: string, storeId: string): Promise<ExtraHit[]> {
  const { supabase } = await requireSection("kasa");
  const text = q.trim().replace(/[^\p{L}\p{N} .-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  if (text.length < 3) return [];
  const key = `${storeId}|${text.toLowerCase()}`;
  const hit = extraCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.hits;
  const [{ data: store }, rules] = await Promise.all([
    supabase.from("stores").select("code, shopify_domain").eq("id", storeId).maybeSingle(),
    loadExclusionRules(supabase),
  ]);
  if (!store?.shopify_domain) return [];
  const ex = {
    skuPrefixes: rules.filter((r) => r.kind === "sku_prefix").map((r) => r.value.toUpperCase()),
    titleContains: rules.filter((r) => r.kind === "title_contains").map((r) => r.value.toLowerCase()),
  };
  type R = { products: { nodes: { id: string; title: string; featuredMedia: { preview: { image: { url: string } | null } | null } | null;
    variants: { nodes: { id: string; title: string; sku: string | null; price: string | null; inventoryQuantity: number | null; inventoryItem: { tracked: boolean } | null }[] } }[] } };
  let data: R;
  try {
    data = await shopifyGraphql<R>(store.shopify_domain as string, store.code as string, `query($q: String!) {
      products(first: 15, query: $q, sortKey: RELEVANCE) { nodes { id title featuredMedia { preview { image { url } } }
        variants(first: 60) { nodes { id title sku price inventoryQuantity inventoryItem { tracked } } } } }
    }`, { q: `status:active ${text.split(" ").map((w) => `${w}*`).join(" ")}` });
  } catch {
    return [];
  }
  const words = text.toLowerCase().split(" ");
  const collator = new Intl.Collator("pl", { numeric: true });
  const hits: ExtraHit[] = [];
  for (const p of data.products.nodes) {
    if (!words.every((w) => p.title.toLowerCase().includes(w) || p.variants.nodes.some((v) => (v.sku ?? "").toLowerCase().includes(w) || v.title.toLowerCase().includes(w)))) continue;
    const vs = p.variants.nodes.filter((v) => v.inventoryItem?.tracked === false || isExcluded(ex, [v.sku], `${p.title} ${v.title}`));
    if (!vs.length) continue;
    hits.push({
      id: p.id, title: p.title, image: p.featuredMedia?.preview?.image?.url ?? null,
      vat: exclusionVat(rules, vs[0].sku, p.title),
      receiptName: exclusionName(rules, vs[0].sku, p.title),
      sizes: vs.map((v) => ({
        id: v.id, option: v.title === "Default Title" ? "" : v.title, price: v.price != null ? Number(v.price) : null,
        available: v.inventoryItem?.tracked === false ? null : v.inventoryQuantity ?? 0,
      })).sort((a, b) => collator.compare(a.option, b.option)),
    });
  }
  extraCache.set(key, { at: Date.now(), hits });
  if (extraCache.size > 200) extraCache.delete(extraCache.keys().next().value!);
  return hits;
}

export type ScanChoice = { variantId: string; title: string; option: string; inStock: number; price: number | null };
/** Zeskanowana sztuka (kod z etykiety) przy wyborze rozmiaru: ten rozmiar jest wyróżniony, a jego wybór dodaje dokładnie tę sztukę. */
export type ScannedUnit = { variantId: string; code: string; unit: PosUnit | null };

/** Najstarsza wolna sztuka rozmiaru: najpierw własne, potem komis; najpierw z lokalizacji sklepu. */
export async function pickUnitForVariant(variantId: string, storeId: string, exclude: string[] = []): Promise<{ unit?: PosUnit; error?: string }> {
  const { supabase } = await requireSection("kasa");
  let q = supabase.from("units").select(SELECT).eq("variant_id", variantId).eq("status", "in_stock");
  if (exclude.length) q = q.not("id", "in", `(${exclude.filter((x) => /^[0-9a-f-]{36}$/.test(x)).join(",")})`);
  const { data } = await q.order("received_at").limit(200);
  const rows = (data ?? []) as unknown as Row[];
  // Sortowanie stabilne: kolejność „od najstarszej” z zapytania zostaje w obrębie grup.
  rows.sort((x, y) =>
    Number(y.location.store_id === storeId) - Number(x.location.store_id === storeId) ||
    Number(x.owner_type === "consignment") - Number(y.owner_type === "consignment"));
  if (!rows.length) return { error: "Tego rozmiaru nie ma na stanie." };
  return { unit: toPos(rows[0], storeId) };
}

/**
 * Skan albo wpisany kod: kod sztuki z etykiety (S000123), IMEI / numer seryjny,
 * SKU rozmiaru, EAN albo SKU modelu ze Shopify (wtedy wybór rozmiaru).
 */
export async function scanUnit(code: string, storeId: string, exclude: string[] = []): Promise<{ unit?: PosUnit; choices?: ScanChoice[]; scanned?: ScannedUnit; error?: string }> {
  const { supabase } = await requireSection("kasa");
  const raw = code.trim();
  const c = raw.toUpperCase().replace(/[^A-Z0-9_./-]/g, "");
  if (!c) return { error: "Pusty kod." };

  // 0. Metka produktu (PR000123): wybór rozmiaru tego produktu.
  const tagNo = parseProductTagCode(c);
  if (tagNo !== null) {
    const { data: prod } = await supabase.from("products").select("id").eq("tag_no", tagNo).maybeSingle();
    if (!prod) return { error: `Nie ma produktu o kodzie ${c}.` };
    const { data: vs } = await supabase.from("variants").select("id").eq("product_id", prod.id);
    const ids = (vs ?? []).map((v) => v.id as string);
    if (ids.length === 1) return pickUnitForVariant(ids[0], storeId, exclude);
    return variantChoices(supabase, ids, storeId);
  }

  // 1. Konkretna sztuka: kod z etykiety albo IMEI.
  const { data } = await supabase.from("units").select(SELECT).or(`code.eq.${c},identifier.eq.${c}`).limit(5);
  const rows = (data ?? []) as unknown as Row[];
  const available = rows.find((r) => r.status === "in_stock" && !exclude.includes(r.id));
  // Kod z etykiety magazynowej (nie IMEI): model z kilkoma rozmiarami → wybór rozmiaru, zeskanowany rozmiar wyróżniony.
  const byCode = rows.find((r) => r.code.toUpperCase() === c);
  if (byCode) {
    const { data: v } = await supabase.from("variants").select("product_id").eq("id", byCode.variant_id).maybeSingle();
    const { data: vs } = v ? await supabase.from("variants").select("id").eq("product_id", v.product_id) : { data: [] };
    const ids = (vs ?? []).map((x) => x.id as string);
    if (ids.length > 1) {
      const scannedFree = byCode.status === "in_stock" && !exclude.includes(byCode.id) ? toPos(byCode, storeId) : null;
      const r = await variantChoices(supabase, ids, storeId);
      if (r.error) return { error: scannedFree ? r.error : `Sztuka ${byCode.code} nie jest na stanie albo jest już w koszyku, a innych rozmiarów tego modelu też nie ma.` };
      return { ...r, scanned: { variantId: byCode.variant_id, code: byCode.code, unit: scannedFree } };
    }
  }
  if (available) return { unit: toPos(available, storeId) };
  if (rows.length) return { error: `Sztuka ${rows[0].code} nie jest na stanie albo jest już w koszyku.` };

  // 2. SKU rozmiaru, SKU ze Shopify (zwykle cały model) albo EAN.
  const [links, eans] = await Promise.all([
    supabase.from("variant_store_links").select("variant_id").or(`base_sku.ilike.${c},sku.ilike.${c}`).limit(200),
    supabase.from("variants").select("id").eq("ean", c).limit(20),
  ]);
  const variantIds = [...new Set([...(links.data ?? []).map((l) => l.variant_id as string), ...(eans.data ?? []).map((v) => v.id as string)])];
  if (!variantIds.length) return { error: `Nie znaleziono kodu „${raw}”.` };
  if (variantIds.length === 1) return pickUnitForVariant(variantIds[0], storeId, exclude);

  // Kilka rozmiarów (SKU modelu ze Shopify) – pokazujemy rozmiary z sztukami na stanie.
  return variantChoices(supabase, variantIds, storeId);
}

async function variantChoices(supabase: Awaited<ReturnType<typeof requireSection>>["supabase"], variantIds: string[], storeId: string): Promise<{ choices?: ScanChoice[]; error?: string }> {
  const { data: variants } = await supabase.from("variants").select("id, option, product:products(title), links:variant_store_links(store_id, price)").in("id", variantIds.slice(0, 100));
  const { data: stock } = await supabase.from("variant_stock_totals").select("variant_id, in_stock").in("variant_id", variantIds.slice(0, 100));
  const counts = new Map((stock ?? []).map((s) => [s.variant_id as string, Number(s.in_stock)]));
  const collator = new Intl.Collator("pl", { numeric: true });
  const choices = (variants ?? [])
    .map((v) => {
      const links = (v.links ?? []) as { store_id: string; price: number | null }[];
      const link = links.find((l) => l.store_id === storeId && l.price != null) ?? links.find((l) => l.price != null);
      return { variantId: v.id as string, title: (v.product as unknown as { title: string }).title, option: v.option as string, inStock: counts.get(v.id as string) ?? 0, price: link?.price != null ? Number(link.price) : null };
    })
    .sort((x, y) => collator.compare(x.option, y.option));
  if (!choices.some((ch) => ch.inStock > 0)) return { error: "Żadnego rozmiaru tego modelu nie ma na stanie." };
  return { choices };
}

/** Ręczne wyszukiwanie: sztuki na stanie pasujące do nazwy, SKU albo EAN. */
export async function searchUnits(q: string, storeId: string): Promise<PosUnit[]> {
  const { supabase } = await requireSection("kasa");
  const text = q.trim().replace(/[,()*%\\]/g, " ").trim();
  if (text.length < 2) return [];
  const variantIds = await findVariantIds(supabase, text);
  if (!variantIds.length) return [];
  const { data } = await supabase.from("units").select(SELECT)
    .in("variant_id", variantIds.slice(0, 150)).eq("status", "in_stock")
    .order("received_at").limit(40);
  return ((data ?? []) as unknown as Row[]).map((r) => toPos(r, storeId));
}

export async function finishPosOrder(_: unknown, formData: FormData): Promise<{ error?: string }> {
  const { supabase, profile } = await requireSection("kasa");
  const storeId = String(formData.get("store_id") ?? "");
  type In = { unit_id?: string; price: string; name?: string; ptu?: string; quantity?: string; product_id?: string; save?: boolean };
  const items = JSON.parse(String(formData.get("items") ?? "[]")) as In[];
  if (!storeId) return { error: "Wybierz sklep." };
  if (!items.length) return { error: "Koszyk jest pusty." };
  // Tryb: "1" paragon fiskalny, "pdf" tylko paragon PDF (bez fiskalnego, poza JPK), "0" bez paragonu, "ship" wysyłka (paragon PDF + zamówienie, poza JPK).
  const mode = String(formData.get("receipt") ?? "1");
  const ship = mode === "ship" ? readParShipping(formData) : null;
  if (mode === "ship" && !ship) return { error: "Zaznacz „Wysyłka” i wpisz dane odbiorcy." };
  if (ship && "error" in ship) return { error: ship.error };
  const parsed = [];
  const num = (v: unknown) => Number(String(v ?? "").replace(/\s/g, "").replace(",", "."));
  for (const i of items) {
    const n = num(i.price);
    if (!Number.isFinite(n) || n <= 0) return { error: "Podaj cenę większą od zera przy każdej pozycji (drukarka fiskalna nie przyjmie 0 zł)." };
    const price = Math.round(n * 100) / 100;
    if (i.unit_id) {
      if (i.ptu && !/^[A-F]$/.test(String(i.ptu))) return { error: "Zła stawka PTU przy sztuce." };
      parsed.push({ unit_id: i.unit_id, price });
    } else {
      const name = String(i.name ?? "").trim().slice(0, 120);
      const qty = num(i.quantity ?? 1);
      if (!name) return { error: "Podaj nazwę pozycji wpisanej ręcznie." };
      if (!/^[A-F]$/.test(String(i.ptu))) return { error: `Wybierz stawkę PTU dla: ${name}.` };
      if (!Number.isFinite(qty) || qty <= 0) return { error: `Zła ilość dla: ${name}.` };
      parsed.push({ name, ptu: i.ptu, price, quantity: qty, product_id: i.product_id || null });
    }
  }
  // Sztuka zarezerwowana = kupiona już w sklepie internetowym (Shopify zdjął stan). Sprzedaż w Kasie odebrałaby ją
  // zamówieniu i zdjęła stan drugi raz.
  const wanted = parsed.map((p) => p.unit_id).filter((x): x is string => !!x);
  if (wanted.length) {
    const { data: busy } = await supabase.from("units").select("code").in("id", wanted).neq("status", "in_stock");
    if (busy?.length) return { error: `Nie na stanie (zarezerwowana przez zamówienie albo już sprzedana): ${busy.map((b) => b.code).join(", ")}. Usuń z koszyka.` };
  }
  // „Zapisz jako własny produkt” – do wyszukiwania w Kasie następnym razem (bez liczenia stanu).
  for (const i of items.filter((x) => !x.unit_id && x.save && !x.product_id)) {
    const name = String(i.name ?? "").trim().slice(0, 120);
    const { data: exists } = await supabase.from("pos_products").select("id").ilike("name", name).eq("active", true).limit(1).maybeSingle();
    if (!exists) await supabase.from("pos_products").insert({ name, price: Math.round(num(i.price) * 100) / 100, ptu: i.ptu, track_stock: false });
  }

  const { data: orderId, error } = await supabase.rpc("create_pos_order", {
    p_store_id: storeId,
    p_items: parsed,
    p_payment: String(formData.get("payment") ?? "card"),
    p_customer: String(formData.get("customer") ?? ""),
    p_note: String(formData.get("note") ?? ""),
  });
  if (error) return { error: error.message };

  // Sprzedaż w kasie: stan w Shopify −1 za każdą sztukę.
  const unitIds = parsed.map((p) => p.unit_id).filter((x): x is string => !!x);
  const { data: units } = unitIds.length ? await supabase.from("units").select("variant_id, location_id").in("id", unitIds) : { data: [] };
  const results = await adjustStock(supabase, (units ?? []).map((u) => ({ variantId: u.variant_id, locationId: u.location_id, delta: -1 })));
  const failed = results.filter((r) => !r.ok);
  await supabase.from("pos_orders").update({
    base_sync_status: failed.length ? "error" : "ok",
    base_sync_error: failed.length ? failed.map((f) => f.message).join("\n") : null,
    base_pending: failed.map(({ variantId, locationId, delta }) => ({ variantId, locationId, delta })),
  }).eq("id", orderId);

  // Stawka PTU wybrana przy sztukach w koszyku (domyślnie: 23% → A, marża → F).
  const admin = createAdminClient();
  // Nazwa zmieniona w koszyku (na paragon) – też przy sztuce.
  for (const i of items.filter((x) => x.unit_id && (/^[A-F]$/.test(String(x.ptu ?? "")) || x.name))) {
    const patch: { ptu?: string; name?: string } = {};
    if (/^[A-F]$/.test(String(i.ptu ?? ""))) patch.ptu = i.ptu;
    if (i.name && String(i.name).trim()) patch.name = String(i.name).trim().slice(0, 120);
    await admin.from("pos_order_items").update(patch).eq("order_id", orderId).eq("unit_id", i.unit_id!);
  }

  // „Drukuj paragon PDF” i „Wysyłka”: bez paragonu fiskalnego – tylko paragon PDF (PAR), poza JPK.
  // Przy wysyłce dodatkowo zamówienie w Sprzedaż → Zamówienia (etykieta), umowy sztuk wracają do niewykorzystanych.
  if (mode === "pdf" || (mode === "ship" && ship && !("error" in ship))) {
    let msg = "";
    try {
      const draft = await draftFromPos(admin, orderId as string);
      if (!draft) throw new Error("Nie ma takiej sprzedaży.");
      const note = String(formData.get("note") ?? "").trim();
      const row = await issueReceipt(admin, { ...draft, notes: note || null }, profile.id);
      if (ship && !("error" in ship)) {
        const r = await createParShippingOrder(admin, { receiptId: row.id, number: row.number, payment: draft.paymentMethod, items: draft.items, ship });
        await admin.from("pos_orders").update({ note: [note, `Wysyłka – zamówienie ${row.number}`].filter(Boolean).join(" · ") }).eq("id", orderId);
        msg = `Paragon ${row.number} (PDF) i zamówienie do wysyłki w Sprzedaż → Zamówienia – poza JPK.${r.freedContracts ? ` Umowy wróciły do niewykorzystanych: ${r.freedContracts}.` : ""}`;
      } else {
        msg = `Paragon ${row.number} (PDF, bez paragonu fiskalnego) – poza JPK.`;
      }
    } catch (e) {
      redirect(`/kasa/${orderId}?blad=${encodeURIComponent(`Sprzedaż zapisana, ale paragon PDF nie powstał: ${errorMessage(e)}`)}`);
    }
    redirect(`/kasa/${orderId}?pdf=1&ok=${encodeURIComponent(msg)}`);
  }

  // „Zakończ i wystaw paragon”: paragon do kolejki drukarki fiskalnej (program przy drukarce drukuje go od razu).
  if (mode === "1") {
    try {
      await enqueuePosReceipt(admin, orderId as string, profile.id);
    } catch (e) {
      redirect(`/kasa/${orderId}?blad=${encodeURIComponent(`Sprzedaż zapisana, ale paragon nie trafił do drukarki: ${errorMessage(e)}`)}`);
    }
  }
  redirect(`/kasa/${orderId}`);
}

export async function retryPosBase(formData: FormData) {
  const { supabase } = await requireSection("kasa");
  const id = String(formData.get("id"));
  const { data: o } = await supabase.from("pos_orders").select("base_pending").eq("id", id).single();
  const results = await adjustStock(supabase, (o?.base_pending ?? []) as { variantId: string; locationId: string; delta: number }[]);
  const failed = results.filter((r) => !r.ok);
  await supabase.from("pos_orders").update({
    base_sync_status: failed.length ? "error" : "ok",
    base_sync_error: failed.length ? failed.map((f) => f.message).join("\n") : null,
    base_pending: failed.map(({ variantId, locationId, delta }) => ({ variantId, locationId, delta })),
  }).eq("id", id);
  redirect(`/kasa/${id}`);
}
