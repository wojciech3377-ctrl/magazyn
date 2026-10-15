import "server-only";
import { safeEqual } from "@/lib/security";
import type { SupabaseClient } from "@supabase/supabase-js";
import { syncFurgonetkaShipments, syncShopifyOrders } from "@/lib/sync/shop-orders";
import { backfillContractNumbers } from "@/lib/contracts/docnumber";
import { furgonetkaConfigured, furgonetkaConnection } from "@/lib/integrations/furgonetka";
import { errorMessage } from "@/lib/errors";
import { pollKsef } from "@/lib/invoices/service";
import { runAutoCatalog } from "@/lib/sync/auto-catalog";
import { ksefConfigured } from "@/lib/ksef/client";
import { notifyConsignorSales } from "@/lib/consignment-notify";
import { runLiveSync } from "@/lib/sync/live";
import { fastJobIssue, syncIssues, type Issue } from "@/lib/issues";

async function run(db: SupabaseClient, job: string, fn: () => Promise<unknown>, logOk = true) {
  try {
    const result = await fn();
    if (logOk) await db.from("sync_log").insert({ job, ok: true, message: JSON.stringify(result) });
    return { ok: true, result };
  } catch (e) {
    const message = errorMessage(e);
    await db.from("sync_log").insert({ job, ok: false, message });
    return { ok: false, error: message };
  }
}

/**
 * Szybkie zadania (co minutę): zamówienia ze Shopify, stany zmienione w Shopify, rozliczenie rezerwacji,
 * przesyłki z Furgonetki, statusy KSeF, e-maile do komisantów.
 */
export async function runFastJobs(db: SupabaseClient) {
  const shop = await run(db, "shopify-orders", () => syncShopifyOrders(db));
  const live = await run(db, "live", () => runLiveSync(db, 0), false);
  {
    const { data: settled, error } = await db.rpc("settle_order_units");
    if (error && !/settle_order_units/.test(error.message)) await db.from("sync_log").insert({ job: "settle", ok: false, message: error.message });
    else if (settled) await db.from("sync_log").insert({ job: "settle", ok: true, message: JSON.stringify({ sold: settled }) });
  }
  try {
    const r = await backfillContractNumbers(db);
    if (r.checked) await db.from("sync_log").insert({ job: "contract-numbers", ok: true, message: JSON.stringify(r) });
  } catch (e) {
    await db.from("sync_log").insert({ job: "contract-numbers", ok: false, message: errorMessage(e) });
  }
  try {
    const r = await notifyConsignorSales(db);
    if (r.sent || "errors" in r) await db.from("sync_log").insert({ job: "consignor-mail", ok: !("errors" in r), message: JSON.stringify(r) });
  } catch (e) {
    await db.from("sync_log").insert({ job: "consignor-mail", ok: false, message: errorMessage(e) });
  }
  if (ksefConfigured()) {
    const { count } = await db.from("invoices").select("id", { count: "exact", head: true }).eq("status", "sending");
    if (count) await run(db, "ksef", () => pollKsef(db));
  }
  const ship = furgonetkaConfigured() && (await furgonetkaConnection(db))
    ? await run(db, "furgonetka", () => syncFurgonetkaShipments(db))
    : { ok: true, result: "niepołączona" };
  return { shop, live, ship, ok: shop.ok && ship.ok };
}

/** Wolne zadania (co 10–15 min): nowe / zmienione produkty ze Shopify i pełne porównanie stanów. */
export async function runSlowJobs(db: SupabaseClient) {
  try {
    const r = await runAutoCatalog(db);
    if (r) {
      await db.from("sync_log").insert({ job: "auto-catalog", ok: true, message: JSON.stringify(r) });
      await syncIssues(db, "auto-catalog-run", []);
    }
    return { ok: true, result: r ?? "za wcześnie (co 15 min)" };
  } catch (e) {
    await db.from("sync_log").insert({ job: "auto-catalog", ok: false, message: errorMessage(e) });
    await syncIssues(db, "auto-catalog-run", [{ key: "przebieg", title: "Automat katalogu i stanów przerwał pracę", detail: errorMessage(e), hint: "Katalog, stany i kategorie nie odświeżają się. Spróbuj „Sprawdź nowe produkty i stany” w Magazynie; gdy błąd wraca – zgłoś go." }]);
    return { ok: false, error: errorMessage(e) };
  }
}

export function cronAuthorized(req: Request) {
  const secret = process.env.CRON_SECRET;
  // Porównanie w stałym czasie (bez ataku czasowego).
  return !!secret && safeEqual(req.headers.get("authorization"), `Bearer ${secret}`);
}
