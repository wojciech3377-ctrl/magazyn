import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";

export type ContractItem = {
  title: string; option?: string; qty?: number; price?: number | string;
  variant_id?: string; unit_id?: string; manual?: boolean; unassigned?: boolean;
};

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Rzeczy z umowy wpisane ręcznie (i wybrane „spoza katalogu Shopify”), jeszcze bez sztuk → od razu sztuki
 * NA STANIE w wybranej lokalizacji, jako „nieprzypisane do Shopify”. Rzeczy o tej samej nazwie trafiają do
 * jednego produktu (rozmiary = warianty) – potem jednym kliknięciem przypiszesz cały produkt do Shopify.
 * Każda sztuka dostaje własną pozycję umowy (ilość 1, unit_id) – usunięcie sztuki wydziela dokładnie ją.
 * Rzeczy z katalogu Shopify zostają bez zmian (do nich dopinasz istniejące sztuki).
 */
export async function stockContractItems(db: SupabaseClient, contractId: string, items: ContractItem[], locationId: string, status: "in_transit" | "in_stock" = "in_transit") {
  const todo = items.map((it, k) => ({ it, k })).filter(({ it }) => !it.unit_id);
  if (!todo.length) return { items, created: 0, error: null };
  const admin = createAdminClient();

  // Wybrane z katalogu, ale produkt „nieprzypisany” (dodany ręcznie w formularzu) – też na stan.
  const vids = [...new Set(todo.map(({ it }) => it.variant_id).filter((v): v is string => !!v))];
  const { data: vrows } = vids.length
    ? await admin.from("variants").select("id, product:products(unassigned)").in("id", vids)
    : { data: [] };
  const unassignedVid = new Set((vrows ?? []).filter((v) => (v.product as unknown as { unassigned?: boolean } | null)?.unassigned).map((v) => v.id as string));
  const stock = todo.filter(({ it }) => !it.variant_id || unassignedVid.has(it.variant_id));
  if (!stock.length) return { items, created: 0, error: null };

  const [{ data: c }, { data: loc }] = await Promise.all([
    db.from("contracts").select("type, consignor_id, vat_form, currency, doc_number, number").eq("id", contractId).single(),
    db.from("locations").select("id, store_id").eq("id", locationId).maybeSingle(),
  ]);
  if (!c) throw new Error("Nie ma takiej umowy.");
  if (!loc) throw new Error("Wybierz lokalizację, na którą trafią rzeczy.");
  const consignment = c.type === "consignment";
  if (consignment && !c.consignor_id) throw new Error("Umowa komisowa bez komisanta – wybierz komisanta, żeby dodać rzeczy do magazynu.");
  const total = stock.reduce((n, { it }) => n + Math.max(1, Math.floor(Number(it.qty ?? 1)) || 1), 0);
  if (total > 500) throw new Error("Najwyżej 500 sztuk naraz.");

  // Produkty „nieprzypisane” – jeden na nazwę, rozmiary jako warianty.
  const products = new Map<string, string>();
  async function variantFor(title: string, option: string): Promise<string> {
    const opt = option.trim().slice(0, 100) || "jeden rozmiar";
    const key = norm(title);
    const pid = products.get(key);
    if (!pid) {
      const { data, error } = await db.rpc("create_unassigned_variant", { p_title: title, p_option: opt });
      if (error || !data) throw new Error(error && /create_unassigned_variant|schema cache/i.test(error.message) ? "Ta funkcja wymaga SQL 63 w Supabase." : error?.message ?? "Nie udało się dodać rzeczy.");
      const { data: v } = await admin.from("variants").select("product_id").eq("id", data as string).single();
      if (v) products.set(key, v.product_id as string);
      return data as string;
    }
    const { data: found } = await admin.from("variants").select("id").eq("product_id", pid).eq("option", opt).maybeSingle();
    if (found) return found.id as string;
    const { data: made, error } = await admin.from("variants").insert({ product_id: pid, option: opt }).select("id").single();
    if (error || !made) throw new Error(error?.message ?? "Nie udało się dodać rozmiaru.");
    return made.id as string;
  }

  const note = `Z umowy ${c.doc_number ?? (c.number ? `NR${c.number}` : "")}`.trim();
  let deliveryId: string | null = null;
  const used = new Set<string>();
  const replaced = new Map<number, ContractItem[]>();
  let failed: string | null = null;
  for (const { it, k } of stock) {
    try {
    const qty = Math.max(1, Math.floor(Number(it.qty ?? 1)) || 1);
    const price = Number(it.price ?? 0) > 0 ? Number(it.price) : null;
    const variantId = it.variant_id ?? (await variantFor(it.title, it.option ?? ""));
    const { data, error } = await db.rpc("receive_delivery", {
      p_store_id: loc.store_id, p_location_id: loc.id, p_variant_id: variantId, p_quantity: qty, p_status: status,
      p_owner_type: consignment ? "consignment" : "own", p_consignor_id: consignment ? c.consignor_id : null,
      p_purchase_form: c.vat_form === "vat_23" ? "vat_23" : "vat_margin",
      p_purchase_price: consignment ? null : price, p_payout_amount: consignment ? price : null,
      p_contract_id: contractId, p_identifiers: [], p_shelf: null, p_note: note, p_delivery_id: deliveryId,
    });
    if (error) throw new Error(`Nie udało się dodać „${it.title}” do magazynu: ${error.message}`);
    deliveryId = data as string;
    const { data: made } = await db.from("units").select("id").eq("delivery_id", deliveryId).eq("variant_id", variantId).order("number");
    const ids = (made ?? []).map((u) => u.id as string).filter((id) => !used.has(id)).slice(0, qty);
    ids.forEach((id) => used.add(id));
    const { data: v } = await admin.from("variants").select("option").eq("id", variantId).single();
    replaced.set(k, ids.map((unitId) => ({
      title: it.title, option: (v?.option as string | undefined) ?? it.option ?? "", qty: 1, price: price ?? 0,
      variant_id: variantId, unit_id: unitId, unassigned: true,
    })));
    } catch (e) {
      // Co już powstało, zostaje zapisane w umowie; reszta pozycji bez zmian.
      failed = e instanceof Error ? e.message : String(e);
      break;
    }
  }
  if (deliveryId && c.currency) await db.from("units").update({ purchase_currency: c.currency }).eq("delivery_id", deliveryId).then(() => null, () => null);
  return { items: items.flatMap((it, k) => replaced.get(k) ?? [it]), created: used.size, error: failed };
}
