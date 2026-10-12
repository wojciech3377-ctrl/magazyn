"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { adjustStock } from "@/lib/stock";
import { errorMessage } from "@/lib/errors";

export type TransferUnit = { id: string; code: string; title: string; option: string; shelf: string | null; image: string | null };
const UUID = /^[0-9a-f-]{36}$/i;

/**
 * Skan przy wysyłce na inny magazyn: kod sztuki albo IMEI (dokładnie ta sztuka), albo SKU / EAN
 * (najstarsza jeszcze niezeskanowana sztuka tego rozmiaru). Tylko sztuki na stanie w magazynie źródłowym.
 */
export async function lookupTransferUnit(fromId: string, scan: string, picked: string[]): Promise<TransferUnit | { error: string }> {
  const { supabase } = await requireProfile();
  if (!UUID.test(fromId)) return { error: "Wybierz magazyn, z którego wysyłasz." };
  const code = scan.trim().replace(/[",()]/g, "").toUpperCase();
  if (code.length < 2) return { error: "Pusty kod." };
  const fields = "id, code, title, option, shelf, image_url, status, location_id, location_name, received_at";
  type U = { id: string; code: string; title: string; option: string; shelf: string | null; image_url: string | null; status: string; location_id: string; location_name: string };
  const { data: exact } = await supabase.from("units_list").select(fields).or(`code.eq.${code},identifier.eq.${code}`).limit(5);
  const u = (exact ?? []) as unknown as U[];
  if (u.length) {
    const here = u.find((x) => x.location_id === fromId && x.status === "in_stock" && !picked.includes(x.id));
    if (here) return { id: here.id, code: here.code, title: here.title, option: here.option, shelf: here.shelf, image: here.image_url };
    const x = u[0];
    if (picked.includes(x.id)) return { error: `${x.code} jest już na liście.` };
    return { error: `${x.code} (${x.title} ${x.option}) nie jest na stanie w tym magazynie – ${x.status === "in_stock" ? `leży w: ${x.location_name}` : `status: ${x.status}`}.` };
  }
  const [{ data: links }, { data: eans }] = await Promise.all([
    supabase.from("variant_store_links").select("variant_id").or(`base_sku.eq.${code},sku.eq.${code}`).limit(20),
    supabase.from("variants").select("id").eq("ean", code).limit(20),
  ]);
  const vids = [...new Set([...(links ?? []).map((l) => l.variant_id as string), ...(eans ?? []).map((v) => v.id as string)])];
  if (!vids.length) return { error: `Nieznany kod: ${code}` };
  let q = supabase.from("units_list").select(fields).in("variant_id", vids).eq("location_id", fromId).eq("status", "in_stock").order("received_at").limit(1);
  if (picked.length) q = q.not("id", "in", `(${picked.join(",")})`);
  const { data: free } = await q;
  const f = (free ?? [])[0] as unknown as U | undefined;
  if (!f) return { error: `Brak (kolejnej) sztuki tego rozmiaru na stanie w tym magazynie: ${code}` };
  return { id: f.id, code: f.code, title: f.title, option: f.option, shelf: f.shelf, image: f.image_url };
}

export type TransferState = { error?: string } | null;

/** Utworzenie przesunięcia: sztuki „w drodze” do magazynu docelowego, stan w Shopify −1 w źródle. Potem druk listy. */
export async function createTransfer(_: TransferState, fd: FormData): Promise<TransferState> {
  const { supabase } = await requireProfile();
  const from = String(fd.get("from") ?? "");
  const to = String(fd.get("to") ?? "");
  const ids = [...new Set(fd.getAll("unit").map(String).filter((x) => UUID.test(x)))];
  if (!UUID.test(from) || !UUID.test(to)) return { error: "Wybierz magazyn źródłowy i docelowy." };
  if (from === to) return { error: "Magazyn docelowy musi być inny niż źródłowy." };
  if (!ids.length) return { error: "Zeskanuj co najmniej jedną rzecz." };
  const { data: before } = await supabase.from("units").select("id, variant_id").in("id", ids);
  const { data: id, error } = await supabase.rpc("create_stock_transfer", { p_from: from, p_to: to, p_unit_ids: ids, p_note: String(fd.get("note") ?? "").slice(0, 300) });
  if (error) return { error: /create_stock_transfer/.test(error.message) ? "Uruchom migrację 0035 w Supabase (przesunięcia)." : error.message };
  let warn = "";
  try {
    const r = await adjustStock(createAdminClient(), (before ?? []).map((u) => ({ variantId: u.variant_id as string, locationId: from, delta: -1 })));
    const failed = r.filter((x) => !x.ok);
    if (failed.length) warn = `Shopify: ${failed.map((f) => f.message).join("; ")}`;
  } catch (e) {
    warn = `Shopify: ${errorMessage(e)}`;
  }
  revalidatePath("/magazyn");
  revalidatePath("/dostawa");
  redirect(`/druk/przesuniecie/${id}?drukuj=1${warn ? `&uwaga=${encodeURIComponent(warn)}` : ""}`);
}
