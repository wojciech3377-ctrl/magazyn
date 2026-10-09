import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getReceipts } from "@/lib/integrations/base";

const KEY = "base_receipts";
// Pierwszy odczyt: od początku roku (JPK za wcześniejsze miesiące).
const FIRST_FROM = Math.floor(Date.UTC(new Date().getUTCFullYear(), 0, 1) / 1000);

/** Paragony z Base (numer i data dokumentu do JPK). Kursor = ostatnie ID paragonu. */
export async function syncBaseReceipts(db: SupabaseClient, maxPages = 10) {
  const { data: st } = await db.from("sync_state").select("value").eq("key", KEY).maybeSingle();
  let idFrom = Number((st?.value as { id_from?: number } | null)?.id_from ?? 0);
  let count = 0;
  for (let page = 0; page < maxPages; page++) {
    const batch = await getReceipts(idFrom ? { idFrom } : { dateFrom: FIRST_FROM });
    const fresh = batch.filter((r) => r.receipt_id >= idFrom);
    if (!fresh.length) break;
    const rows = fresh.map((r) => ({
      source: "base",
      base_receipt_id: r.receipt_id,
      number: String(r.receipt_nr ?? r.receipt_full_nr ?? r.receipt_id),
      issued_at: new Date(r.date_add * 1000).toISOString(),
      base_order_id: r.order_id || null,
      currency: r.currency ?? null,
      items: r.products ?? [],
    }));
    const { error } = await db.from("receipts").upsert(rows, { onConflict: "base_receipt_id" });
    if (error) throw error;
    count += rows.length;
    const maxId = Math.max(...fresh.map((r) => r.receipt_id));
    const next = maxId + 1;
    await db.from("sync_state").upsert({ key: KEY, value: { id_from: next }, updated_at: new Date().toISOString() });
    if (batch.length < 100 || next === idFrom) break;
    idFrom = next;
  }
  return { receipts: count };
}
