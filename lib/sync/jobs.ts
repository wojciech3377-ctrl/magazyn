import "server-only";
import { safeEqual } from "@/lib/security";
import type { SupabaseClient } from "@supabase/supabase-js";
import { pushPendingTracking, syncFurgonetkaShipments, syncShopifyOrders } from "@/lib/sync/shop-orders";
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
  // Nieudane zadania → „Błędy automatu” w Ustawieniach (po 3 nieudanych przebiegach z rzędu).
  const failed: Issue[] = [];
  const shop = await run(db, "shopify-orders", () => syncShopifyOrders(db));
  if (!shop.ok) failed.push(fastJobIssue("shopify-orders", shop.error));
  const live = await run(db, "live", () => runLiveSync(db, 0), false);
  {
    const { data: settled, error } = await db.rpc("settle_order_units");
    if (error && !/settle_order_units/.test(error.message)) {
      await db.from("sync_log").insert({ job: "settle", ok: false, message: error.message });
      failed.push(fastJobIssue("settle", error.message));
    } else if (settled) await db.from("sync_log").insert({ job: "settle", ok: true, message: JSON.stringify({ sold: settled }) });
  }
  // Niezależne od siebie – równolegle (krótszy przebieg co minutę).
  const [, , , ship] = await Promise.all([
    (async () => {
      try {
        const r = await backfillContractNumbers(db);
        if (r.checked) await db.from("sync_log").insert({ job: "contract-numbers", ok: true, message: JSON.stringify(r) });
      } catch (e) {
        await db.from("sync_log").insert({ job: "contract-numbers", ok: false, message: errorMessage(e) });
      }
    })(),
    (async () => {
      try {
        const r = await notifyConsignorSales(db);
        if (r.sent || ("reminded" in r && (r.reminded || r.monthly)) || "errors" in r) await db.from("sync_log").insert({ job: "consignor-mail", ok: !("errors" in r), message: JSON.stringify(r) });
        if ("errors" in r && r.errors?.length) failed.push(fastJobIssue("consignor-mail", r.errors.join(" · ")));
      } catch (e) {
        await db.from("sync_log").insert({ job: "consignor-mail", ok: false, message: errorMessage(e) });
        failed.push(fastJobIssue("consignor-mail", e));
      }
    })(),
    (async () => {
      if (!ksefConfigured()) return;
      const { count } = await db.from("invoices").select("id", { count: "exact", head: true }).eq("status", "sending");
      if (!count) return;
      const k = await run(db, "ksef", () => pollKsef(db));
      if (!k.ok) failed.push(fastJobIssue("ksef", k.error));
    })(),
    (async () => {
      const connected = furgonetkaConfigured() && (await furgonetkaConnection(db));
      const r = connected
        ? await run(db, "furgonetka", () => syncFurgonetkaShipments(db))
        : { ok: true, result: "niepołączona" as unknown };
      if (!r.ok && "error" in r) failed.push(fastJobIssue("furgonetka", r.error));
      // Numery przesyłek do Shopify – niezależnie od tego, czy odczyt listy paczek się udał.
      if (connected) {
        try {
          const t = await pushPendingTracking(db);
          if (t.sent || t.errors?.length) await db.from("sync_log").insert({ job: "tracking-shopify", ok: !t.errors?.length, message: JSON.stringify(t) });
          if (t.errors?.length) failed.push(fastJobIssue("tracking-shopify", t.errors.join(" · ")));
        } catch (e) {
          await db.from("sync_log").insert({ job: "tracking-shopify", ok: false, message: errorMessage(e) });
          failed.push(fastJobIssue("tracking-shopify", e));
        }
      }
      return r;
    })(),
  ]);
  // Zmienione sztuki → stan w sklepach-kopiach (np. Owca Store) – mały odczyt (tylko zdarzenia od ostatniej minuty).
  const mirrorStock = await run(db, "mirror-stock", async () => (await import("@/lib/sync/shopify-stock")).pushRecentToMirrors(db), false);
  if (!mirrorStock.ok) failed.push(fastJobIssue("mirror-stock", mirrorStock.error));
  await syncIssues(db, "fast", failed);
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
