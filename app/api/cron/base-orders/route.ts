import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncBaseOrders } from "@/lib/sync/orders";
import { syncFurgonetkaShipments, syncShopifyOrders } from "@/lib/sync/shop-orders";
import { syncBaseReceipts } from "@/lib/sync/receipts";
import { backfillContractNumbers } from "@/lib/contracts/docnumber";
import { furgonetkaConfigured, furgonetkaConnection } from "@/lib/integrations/furgonetka";
import { errorMessage } from "@/lib/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Db = ReturnType<typeof createAdminClient>;

async function run(db: Db, job: string, fn: () => Promise<unknown>) {
  try {
    const result = await fn();
    await db.from("sync_log").insert({ job, ok: true, message: JSON.stringify(result) });
    return { ok: true, result };
  } catch (e) {
    const message = errorMessage(e);
    await db.from("sync_log").insert({ job, ok: false, message });
    return { ok: false, error: message };
  }
}

/**
 * Wywoływane co kilka minut (pg_cron w Supabase) z nagłówkiem Authorization: Bearer CRON_SECRET.
 * Kolejno: linie sprzedaży z Base (przypisanie sztuk), zamówienia ze sklepów Shopify, przesyłki z Furgonetki.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const db = createAdminClient();
  const base = await run(db, "base-orders", () => syncBaseOrders(db));
  const shop = await run(db, "shopify-orders", () => syncShopifyOrders(db));
  const receipts = await run(db, "base-receipts", () => syncBaseReceipts(db));
  // Numery umów ze skanów: w dzienniku tylko, gdy coś sprawdzono albo był błąd.
  try {
    const r = await backfillContractNumbers(db);
    if (r.checked) await db.from("sync_log").insert({ job: "contract-numbers", ok: true, message: JSON.stringify(r) });
  } catch (e) {
    await db.from("sync_log").insert({ job: "contract-numbers", ok: false, message: errorMessage(e) });
  }
  const ship = furgonetkaConfigured() && (await furgonetkaConnection(db))
    ? await run(db, "furgonetka", () => syncFurgonetkaShipments(db))
    : { ok: true, result: "niepołączona" };
  return NextResponse.json({ base, shop, receipts, ship }, { status: base.ok && shop.ok && receipts.ok && ship.ok ? 200 : 500 });
}

export const POST = GET;
