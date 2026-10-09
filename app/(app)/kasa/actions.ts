"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { warsawMidnight } from "@/lib/month";
import { requireProfile } from "@/lib/auth";
import { findVariantIds } from "@/lib/queries/units";
import { adjustBaseStock } from "@/lib/stock";

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
};

const SELECT = `id, code, identifier, status, owner_type, received_at, variant_id, location_id, consignor:consignors(name),
  location:locations(name, store_id),
  variant:variants(option, links:variant_store_links(store_id, price), product:products(title, image_url))`;

type Row = {
  id: string; code: string; identifier: string | null; status: string; owner_type: string;
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
  };
}

export type ScanChoice = { variantId: string; title: string; option: string; inStock: number };

/** Najstarsza wolna sztuka rozmiaru: najpierw własne, potem komis; najpierw z lokalizacji sklepu. */
export async function pickUnitForVariant(variantId: string, storeId: string, exclude: string[] = []): Promise<{ unit?: PosUnit; error?: string }> {
  const { supabase } = await requireProfile();
  let q = supabase.from("units").select(SELECT).eq("variant_id", variantId).in("status", ["in_stock", "reserved"]);
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
 * SKU rozmiaru z Base, EAN albo SKU modelu ze Shopify (wtedy wybór rozmiaru).
 */
export async function scanUnit(code: string, storeId: string, exclude: string[] = []): Promise<{ unit?: PosUnit; choices?: ScanChoice[]; error?: string }> {
  const { supabase } = await requireProfile();
  const raw = code.trim();
  const c = raw.toUpperCase().replace(/[^A-Z0-9_./-]/g, "");
  if (!c) return { error: "Pusty kod." };

  // 1. Konkretna sztuka: kod z etykiety albo IMEI.
  const { data } = await supabase.from("units").select(SELECT).or(`code.eq.${c},identifier.eq.${c}`).limit(5);
  const rows = (data ?? []) as unknown as Row[];
  const available = rows.find((r) => (r.status === "in_stock" || r.status === "reserved") && !exclude.includes(r.id));
  if (available) return { unit: toPos(available, storeId) };
  if (rows.length) return { error: `Sztuka ${rows[0].code} nie jest na stanie albo jest już w koszyku.` };

  // 2. SKU z Base (rozmiar), SKU ze Shopify (zwykle cały model) albo EAN.
  const [links, eans] = await Promise.all([
    supabase.from("variant_store_links").select("variant_id").or(`base_sku.ilike.${c},sku.ilike.${c}`).limit(200),
    supabase.from("variants").select("id").eq("ean", c).limit(20),
  ]);
  const variantIds = [...new Set([...(links.data ?? []).map((l) => l.variant_id as string), ...(eans.data ?? []).map((v) => v.id as string)])];
  if (!variantIds.length) return { error: `Nie znaleziono „${raw}”. Zeskanuj etykietę, IMEI, SKU z Base, SKU ze Shopify albo EAN.` };
  if (variantIds.length === 1) return pickUnitForVariant(variantIds[0], storeId, exclude);

  // Kilka rozmiarów (SKU modelu ze Shopify) – pokazujemy rozmiary z sztukami na stanie.
  const { data: variants } = await supabase.from("variants").select("id, option, product:products(title)").in("id", variantIds.slice(0, 100));
  const { data: stock } = await supabase.from("variant_stock_totals").select("variant_id, in_stock").in("variant_id", variantIds.slice(0, 100));
  const counts = new Map((stock ?? []).map((s) => [s.variant_id as string, Number(s.in_stock)]));
  const collator = new Intl.Collator("pl", { numeric: true });
  const choices = (variants ?? [])
    .map((v) => ({ variantId: v.id as string, title: (v.product as unknown as { title: string }).title, option: v.option as string, inStock: counts.get(v.id as string) ?? 0 }))
    .sort((x, y) => collator.compare(x.option, y.option));
  if (!choices.some((ch) => ch.inStock > 0)) return { error: "Żadnego rozmiaru tego modelu nie ma na stanie." };
  return { choices };
}

/** Ręczne wyszukiwanie: sztuki na stanie pasujące do nazwy, SKU albo EAN. */
export async function searchUnits(q: string, storeId: string): Promise<PosUnit[]> {
  const { supabase } = await requireProfile();
  const text = q.trim().replace(/[,()*%\\]/g, " ").trim();
  if (text.length < 2) return [];
  const variantIds = await findVariantIds(supabase, text);
  if (!variantIds.length) return [];
  const { data } = await supabase.from("units").select(SELECT)
    .in("variant_id", variantIds.slice(0, 150)).in("status", ["in_stock", "reserved"])
    .order("received_at").limit(40);
  return ((data ?? []) as unknown as Row[]).map((r) => toPos(r, storeId));
}

export async function finishPosOrder(_: unknown, formData: FormData): Promise<{ error?: string }> {
  const { supabase } = await requireProfile();
  const storeId = String(formData.get("store_id") ?? "");
  const items = JSON.parse(String(formData.get("items") ?? "[]")) as { unit_id: string; price: string }[];
  if (!storeId) return { error: "Wybierz sklep." };
  if (!items.length) return { error: "Koszyk jest pusty." };
  const parsed = [];
  for (const i of items) {
    const n = Number(String(i.price).replace(/\s/g, "").replace(",", "."));
    if (!Number.isFinite(n) || n < 0) return { error: "Podaj poprawną cenę przy każdej sztuce." };
    parsed.push({ unit_id: i.unit_id, price: Math.round(n * 100) / 100 });
  }

  const { data: orderId, error } = await supabase.rpc("create_pos_order", {
    p_store_id: storeId,
    p_items: parsed,
    p_payment: String(formData.get("payment") ?? "card"),
    p_customer: String(formData.get("customer") ?? ""),
    p_note: String(formData.get("note") ?? ""),
  });
  if (error) return { error: error.message };

  // Sprzedaż poza Base: stan w Base −1 za każdą sztukę (Base zaktualizuje sklepy).
  const { data: units } = await supabase.from("units").select("variant_id, location_id").in("id", parsed.map((p) => p.unit_id));
  const results = await adjustBaseStock(supabase, (units ?? []).map((u) => ({ variantId: u.variant_id, locationId: u.location_id, delta: -1 })));
  const failed = results.filter((r) => !r.ok);
  await supabase.from("pos_orders").update({
    base_sync_status: failed.length ? "error" : "ok",
    base_sync_error: failed.length ? failed.map((f) => f.message).join("\n") : null,
    base_pending: failed.map(({ variantId, locationId, delta }) => ({ variantId, locationId, delta })),
  }).eq("id", orderId);

  redirect(`/kasa/${orderId}`);
}

export async function retryPosBase(formData: FormData) {
  const { supabase } = await requireProfile();
  const id = String(formData.get("id"));
  const { data: o } = await supabase.from("pos_orders").select("base_pending").eq("id", id).single();
  const results = await adjustBaseStock(supabase, (o?.base_pending ?? []) as { variantId: string; locationId: string; delta: number }[]);
  const failed = results.filter((r) => !r.ok);
  await supabase.from("pos_orders").update({
    base_sync_status: failed.length ? "error" : "ok",
    base_sync_error: failed.length ? failed.map((f) => f.message).join("\n") : null,
    base_pending: failed.map(({ variantId, locationId, delta }) => ({ variantId, locationId, delta })),
  }).eq("id", id);
  redirect(`/kasa/${id}`);
}

/** Numer paragonu do sprzedaży stacjonarnej (wpisany ręcznie – do czasu połączenia z drukarką Elzab). */
export async function savePosReceipt(formData: FormData) {
  const { supabase } = await requireProfile();
  const posOrderId = String(formData.get("id"));
  const number = String(formData.get("number") ?? "").trim().slice(0, 40);
  const date = String(formData.get("date") ?? "");
  const back = `/kasa/${posOrderId}`;
  if (!number) redirect(`${back}?blad=${encodeURIComponent("Wpisz numer paragonu.")}`);
  // Data i godzina z formularza to czas polski.
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  const issued = m ? new Date(warsawMidnight(+m[1], +m[2], +m[3]).getTime() + (+m[4] * 60 + +m[5]) * 60_000) : new Date();
  const { data: existing } = await supabase.from("receipts").select("id").eq("pos_order_id", posOrderId).eq("source", "manual").maybeSingle();
  const row = { number, issued_at: issued.toISOString(), pos_order_id: posOrderId, source: "manual" };
  const { error } = existing
    ? await supabase.from("receipts").update(row).eq("id", existing.id)
    : await supabase.from("receipts").insert(row);
  revalidatePath(back);
  redirect(`${back}?${error ? "blad" : "ok"}=${encodeURIComponent(error ? error.message : "Paragon zapisany.")}`);
}
