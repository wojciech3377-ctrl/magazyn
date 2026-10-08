"use server";

import { redirect } from "next/navigation";
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

const SELECT = `id, code, identifier, status, variant_id, location_id, consignor:consignors(name),
  location:locations(name, store_id),
  variant:variants(option, links:variant_store_links(store_id, price), product:products(title, image_url))`;

type Row = {
  id: string; code: string; identifier: string | null; status: string;
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

/** Skan: kod sztuki z etykiety (S000123) albo IMEI / numer seryjny. */
export async function scanUnit(code: string, storeId: string): Promise<{ unit?: PosUnit; error?: string }> {
  const { supabase } = await requireProfile();
  const c = code.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  if (!c) return { error: "Pusty kod." };
  const { data } = await supabase.from("units").select(SELECT).or(`code.eq.${c},identifier.eq.${c}`).limit(5);
  const rows = (data ?? []) as unknown as Row[];
  const available = rows.find((r) => r.status === "in_stock" || r.status === "reserved");
  if (available) return { unit: toPos(available, storeId) };
  if (rows.length) return { error: `Sztuka ${rows[0].code} nie jest na stanie (status: ${rows[0].status}).` };
  return { error: `Nie znaleziono sztuki „${code}”. Zeskanuj kod z etykiety albo IMEI.` };
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
