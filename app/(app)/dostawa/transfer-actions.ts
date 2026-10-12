"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSection } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { adjustStock } from "@/lib/stock";

const back = (msg: string, ok = true): never => redirect(`/dostawa?zakladka=w-drodze&${ok ? "ok" : "blad"}=${encodeURIComponent(msg)}`);

/** Przesunięcie dotarło: zaznaczone sztuki na stan w magazynie docelowym (+1 w Shopify). */
export async function receiveTransfer(fd: FormData) {
  const { supabase } = await requireSection("dostawa", "magazyn");
  const id = String(fd.get("transfer_id") ?? "");
  const picked = fd.getAll("unit").map(String);
  if (!picked.length) back("Zaznacz rzeczy, które dotarły.", false);
  const { data, error } = await supabase.rpc("receive_stock_transfer", { p_id: id, p_unit_ids: picked });
  if (error) back(error.message, false);
  const rows = (data ?? []) as { unit_id: string; variant_id: string; location_id: string; to_status: string }[];
  const toStock = rows.filter((r) => r.to_status === "in_stock");
  const r = await adjustStock(createAdminClient(), toStock.map((u) => ({ variantId: u.variant_id, locationId: u.location_id, delta: 1 })));
  const failed = r.filter((x) => !x.ok);
  revalidatePath("/dostawa");
  revalidatePath("/magazyn");
  back(`Przyjęto ${rows.length} szt. z przesunięcia${rows.length - toStock.length ? ` (do zamówień: ${rows.length - toStock.length})` : ""}.${failed.length ? ` Shopify: ${failed.map((f) => f.message).join("; ")}` : ""}`, !failed.length);
}

/** Anulowanie przesunięcia: rzeczy jeszcze w drodze wracają na stan magazynu źródłowego (+1 w Shopify tam). */
export async function cancelTransfer(fd: FormData) {
  const { supabase } = await requireSection("dostawa", "magazyn");
  const { data, error } = await supabase.rpc("cancel_stock_transfer", { p_id: String(fd.get("transfer_id") ?? "") });
  if (error) back(error.message, false);
  const rows = (data ?? []) as { unit_id: string; variant_id: string; location_id: string }[];
  const r = await adjustStock(createAdminClient(), rows.map((u) => ({ variantId: u.variant_id, locationId: u.location_id, delta: 1 })));
  const failed = r.filter((x) => !x.ok);
  revalidatePath("/dostawa");
  revalidatePath("/magazyn");
  back(`Przesunięcie anulowane – ${rows.length} szt. wróciło na stan.${failed.length ? ` Shopify: ${failed.map((f) => f.message).join("; ")}` : ""}`, !failed.length);
}
