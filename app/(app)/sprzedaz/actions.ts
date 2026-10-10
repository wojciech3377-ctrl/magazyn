"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin, requireProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncBaseOrders } from "@/lib/sync/orders";
import { syncFurgonetkaShipments, syncShopifyOrders } from "@/lib/sync/shop-orders";
import { fetchReceiptsForOrders, syncBaseReceipts } from "@/lib/sync/receipts";
import { furgonetkaConfigured, furgonetkaConnection } from "@/lib/integrations/furgonetka";
import { errorMessage } from "@/lib/errors";

/** Zamiana sztuki przy pakowaniu: skan kodu sztuki, IMEI albo numeru seryjnego. */
export async function swapUnit(_: unknown, formData: FormData): Promise<{ ok?: string; error?: string }> {
  const { supabase } = await requireProfile();
  const saleId = String(formData.get("sale_id"));
  const code = String(formData.get("code") ?? "").trim();
  if (!code) return { error: "Zeskanuj albo wpisz kod sztuki." };
  const { error } = await supabase.rpc("swap_sale_unit", { p_sale_id: saleId, p_code: code });
  if (error) return { error: error.message };
  revalidatePath("/sprzedaz");
  return { ok: "Sztuka zmieniona." };
}

/** Ręczne pobranie: linie z Base, zamówienia ze Shopify i przesyłki z Furgonetki (to samo robi zadanie co 5 minut). */
export async function pullOrdersNow() {
  await requireAdmin();
  const db = createAdminClient();
  const jobs: [string, () => Promise<unknown>][] = [
    ["base-orders", () => syncBaseOrders(db)],
    ["shopify-orders", () => syncShopifyOrders(db)],
    ["base-receipts", () => syncBaseReceipts(db)],
  ];
  if (furgonetkaConfigured() && (await furgonetkaConnection(db))) jobs.push(["furgonetka", () => syncFurgonetkaShipments(db)]);
  for (const [job, fn] of jobs) {
    try {
      const result = await fn();
      await db.from("sync_log").insert({ job, ok: true, message: JSON.stringify(result) });
    } catch (e) {
      await db.from("sync_log").insert({ job, ok: false, message: errorMessage(e) });
    }
  }
  revalidatePath("/sprzedaz");
}

/** JPK: pobranie z Base paragonów, których brakuje w naszym systemie. */
export async function fetchMissingReceipts(formData: FormData) {
  await requireProfile();
  const db = createAdminClient();
  const back = String(formData.get("back") ?? "/sprzedaz?widok=jpk");
  const ids = String(formData.get("base_orders") ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
  let msg: string;
  let ok = true;
  try {
    const synced = await syncBaseReceipts(db);
    const r = ids.length ? await fetchReceiptsForOrders(db, ids) : { checked: 0, found: 0 };
    msg = `Base: nowych paragonów ${synced.receipts}, do brakujących zamówień znaleziono ${r.found} z ${r.checked}.`;
  } catch (e) {
    ok = false;
    msg = `Base: ${e instanceof Error ? e.message : String(e)}`;
  }
  revalidatePath("/sprzedaz");
  redirect(`${back.startsWith("/sprzedaz") ? back : "/sprzedaz?widok=jpk"}&${ok ? "ok" : "blad"}=${encodeURIComponent(msg)}`);
}
