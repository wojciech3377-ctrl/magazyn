"use server";

import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { findVariantIds } from "@/lib/queries/units";
import { adjustBaseStock } from "@/lib/stock";
import { parseAmount, uploadedFile } from "@/lib/contracts/upload";

export type VariantHit = {
  productId: string;
  title: string;
  styleSku: string | null;
  image: string | null;
  variants: { id: string; option: string; inStock: number; baseLinked: boolean; baseSku: string | null }[];
};

/** Wyszukiwarka produktów do przyjęcia dostawy (nazwa, SKU modelu, SKU z Base, EAN, skan). */
export async function searchVariants(q: string, storeId: string): Promise<VariantHit[]> {
  const { supabase } = await requireProfile();
  const text = q.trim().replace(/[,()*%\\]/g, " ").trim();
  if (text.length < 2) return [];
  const ids = await findVariantIds(supabase, text);
  if (!ids.length) return [];
  const { data: variants } = await supabase
    .from("variants")
    .select("id, option, position, product:products!inner(id, title, style_sku, image_url), links:variant_store_links(store_id, base_product_id, base_sku, base_link_source)")
    .in("id", ids.slice(0, 150));
  const { data: stock } = await supabase.from("variant_stock_totals").select("variant_id, in_stock").in("variant_id", ids.slice(0, 150));
  const counts = new Map((stock ?? []).map((s) => [s.variant_id as string, Number(s.in_stock)]));

  const byProduct = new Map<string, VariantHit>();
  for (const v of variants ?? []) {
    const p = v.product as unknown as { id: string; title: string; style_sku: string | null; image_url: string | null };
    const links = (v.links ?? []) as { store_id: string; base_product_id: number | null; base_sku: string | null; base_link_source: string | null }[];
    const link = links.find((l) => l.store_id === storeId && l.base_product_id && ["base", "manual"].includes(l.base_link_source ?? ""));
    const hit = byProduct.get(p.id) ?? { productId: p.id, title: p.title, styleSku: p.style_sku, image: p.image_url, variants: [] };
    hit.variants.push({ id: v.id, option: v.option, inStock: counts.get(v.id) ?? 0, baseLinked: !!link, baseSku: link?.base_sku ?? null });
    byProduct.set(p.id, hit);
  }
  const collator = new Intl.Collator("pl", { numeric: true });
  return [...byProduct.values()].slice(0, 20).map((h) => ({ ...h, variants: h.variants.sort((a, b) => collator.compare(a.option, b.option)) }));
}

type Line = { variantId: string; quantity: number; price: string; payout: string; identifiers: string };

export async function createDelivery(_: unknown, formData: FormData): Promise<{ error?: string }> {
  const { supabase } = await requireProfile();
  let deliveryId: string | null = null;
  try {
    const storeId = String(formData.get("store_id") ?? "");
    const locationId = String(formData.get("location_id") ?? "");
    const status = formData.get("in_transit") ? "in_transit" : "in_stock";
    const ownerType = String(formData.get("owner_type") ?? "own");
    const consignorId = String(formData.get("consignor_id") ?? "") || null;
    const purchaseForm = String(formData.get("purchase_form")) === "vat_23" ? "vat_23" : "vat_margin";
    const shelf = String(formData.get("shelf") ?? "").trim() || null;
    const note = String(formData.get("note") ?? "").trim() || null;
    const lines = JSON.parse(String(formData.get("lines") ?? "[]")) as Line[];
    if (!storeId || !locationId) return { error: "Wybierz sklep i lokalizację." };
    if (!lines.length) return { error: "Dodaj co najmniej jeden rozmiar." };
    if (ownerType === "consignment" && !consignorId) return { error: "Dla komisu wybierz komisanta." };

    // Umowa: brak, istniejąca albo nowa z plikiem.
    const contractMode = String(formData.get("contract_mode") ?? "none");
    let contractId: string | null = null;
    if (contractMode === "existing") {
      contractId = String(formData.get("contract_id") ?? "") || null;
      if (!contractId) return { error: "Wybierz umowę z listy." };
    }
    if (contractMode === "new") {
      const counterparty = String(formData.get("counterparty") ?? "").trim();
      if (!counterparty) return { error: "Podaj, z kim jest umowa." };
      const file = uploadedFile(formData);
      const { data: c, error } = await supabase.from("contracts").insert({
        type: String(formData.get("contract_type") ?? (ownerType === "consignment" ? "consignment" : "purchase")),
        counterparty,
        consignor_id: ownerType === "consignment" ? consignorId : null,
        contract_date: String(formData.get("contract_date") ?? "") || null,
        amount: parseAmount(formData.get("contract_amount")),
        file_path: file?.path ?? null,
        file_name: file?.name ?? null,
      }).select("id").single();
      if (error) throw error;
      contractId = c.id;
    }

    for (const line of lines) {
      const identifiers = line.identifiers.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
      if (identifiers.length > line.quantity) throw new Error(`Podano więcej numerów IMEI/seryjnych (${identifiers.length}) niż sztuk (${line.quantity}).`);
      const { data, error } = await supabase.rpc("receive_delivery", {
        p_store_id: storeId,
        p_location_id: locationId,
        p_variant_id: line.variantId,
        p_quantity: line.quantity,
        p_status: status,
        p_owner_type: ownerType,
        p_consignor_id: consignorId,
        p_purchase_form: purchaseForm,
        p_purchase_price: parseAmount(line.price),
        p_payout_amount: ownerType === "consignment" ? parseAmount(line.payout) : null,
        p_contract_id: contractId,
        p_identifiers: identifiers,
        p_shelf: shelf,
        p_note: note,
        p_delivery_id: deliveryId,
      });
      if (error) throw error;
      deliveryId = data as string;
    }

    // Stan w Base: +N dla każdego rozmiaru, tak jak ręczne 0 → 1.
    if (status === "in_stock") {
      const results = await adjustBaseStock(supabase, lines.map((l) => ({ variantId: l.variantId, locationId, delta: l.quantity })));
      await saveBaseResult(supabase, deliveryId!, results);
    } else {
      await supabase.from("deliveries").update({ base_sync_status: "skipped" }).eq("id", deliveryId!);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e);
    if (!deliveryId) return { error: msg };
    // Zapisane linie jeszcze nie trafiły do Base – zostają do ponowienia z ekranu dostawy.
    const { data: saved } = await supabase.from("units").select("variant_id, location_id").eq("delivery_id", deliveryId).eq("status", "in_stock");
    const pending = new Map<string, { variantId: string; locationId: string; delta: number }>();
    for (const u of saved ?? []) {
      const p = pending.get(u.variant_id) ?? { variantId: u.variant_id, locationId: u.location_id, delta: 0 };
      p.delta++;
      pending.set(u.variant_id, p);
    }
    await supabase.from("deliveries").update({
      base_sync_status: "error",
      base_sync_error: `Dostawa zapisana tylko częściowo: ${msg}`,
      base_pending: [...pending.values()],
    }).eq("id", deliveryId);
  }
  redirect(`/dostawa/${deliveryId}`);
}

async function saveBaseResult(
  supabase: Awaited<ReturnType<typeof requireProfile>>["supabase"],
  deliveryId: string,
  results: Awaited<ReturnType<typeof adjustBaseStock>>,
) {
  const failed = results.filter((r) => !r.ok);
  await supabase.from("deliveries").update({
    base_sync_status: failed.length ? "error" : "ok",
    base_sync_error: failed.length ? failed.map((f) => f.message).join("\n") : null,
    base_pending: failed.map(({ variantId, locationId, delta }) => ({ variantId, locationId, delta })),
  }).eq("id", deliveryId);
}

/** Ponowienie tych zmian stanu w Base, które za pierwszym razem się nie udały. */
export async function retryDeliveryBase(formData: FormData) {
  const { supabase } = await requireProfile();
  const id = String(formData.get("id"));
  const { data: d } = await supabase.from("deliveries").select("base_pending").eq("id", id).single();
  const pending = (d?.base_pending ?? []) as { variantId: string; locationId: string; delta: number }[];
  const results = await adjustBaseStock(supabase, pending);
  await saveBaseResult(supabase, id, results);
  redirect(`/dostawa/${id}`);
}
