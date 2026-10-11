import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { shopifyGraphql } from "@/lib/integrations/shopify";

/**
 * „Dlaczego aplikacja pokazuje inny stan niż Shopify?” – dla produktów pasujących do wyszukiwania:
 * stan każdego rozmiaru w Shopify (po lokalizacjach) obok sztuk w aplikacji i przyczyną różnicy.
 */
export type DiagRow = {
  store: string; product: string; productGid: string; status: string; tags: string[];
  variant: string; sku: string | null; tracked: boolean;
  shopify: { location: string; qty: number; mapped: boolean }[];
  appVariantId: string | null; shared: number; units: number; waiting: string | null; reasons: string[];
};

type Q = { products: { nodes: { id: string; title: string; status: string; tags: string[]; variants: { nodes: { id: string; title: string; sku: string | null; inventoryItem: { id: string; tracked: boolean; inventoryLevels: { nodes: { location: { id: string; name: string }; quantities: { quantity: number }[] }[] } } | null }[] } }[] } };

export async function diagnoseStock(db: SupabaseClient, text: string): Promise<{ rows: DiagRow[]; errors: string[] }> {
  const { data: stores } = await db.from("stores").select("id, name, code, shopify_domain").not("shopify_domain", "is", null);
  const { data: locs } = await db.from("locations").select("id, name, store_id, active, shopify_location_id");
  const rows: DiagRow[] = [];
  const errors: string[] = [];
  for (const st of stores ?? []) {
    let data: Q;
    try {
      data = await shopifyGraphql<Q>(st.shopify_domain as string, st.code as string,
        `query($q: String!) { products(first: 8, query: $q) { nodes { id title status tags variants(first: 30) { nodes { id title sku inventoryItem { id tracked inventoryLevels(first: 5) { nodes { location { id name } quantities(names: ["available"]) { quantity } } } } } } } } }`,
        { q: text });
    } catch (e) {
      errors.push(`${st.name}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const mappedLoc = new Map((locs ?? []).filter((l) => l.store_id === st.id && l.active && l.shopify_location_id).map((l) => [String(l.shopify_location_id).split("/").pop(), l.id as string]));
    const variantGids = data.products.nodes.flatMap((p) => p.variants.nodes.map((v) => v.id));
    const { data: links } = variantGids.length ? await db.from("variant_store_links").select("variant_id, shopify_variant_id, inventory_tracked").eq("store_id", st.id).in("shopify_variant_id", variantGids) : { data: [] };
    const appOf = new Map((links ?? []).map((l) => [l.shopify_variant_id as string, l.variant_id as string]));
    const appIds = [...new Set([...appOf.values()])];
    const [{ data: sharedRows }, { data: units }, { data: excess }] = await Promise.all([
      appIds.length ? db.from("variant_store_links").select("variant_id").eq("store_id", st.id).in("variant_id", appIds) : Promise.resolve({ data: [] }),
      appIds.length ? db.from("units").select("variant_id, location_id, status").in("variant_id", appIds).in("status", ["in_stock", "reserved"]) : Promise.resolve({ data: [] }),
      appIds.length ? db.from("stock_excess").select("variant_id, missing, first_seen_at").in("variant_id", appIds) : Promise.resolve({ data: [] }),
    ]);
    const sharedCount = new Map<string, number>();
    for (const r of sharedRows ?? []) sharedCount.set(r.variant_id as string, (sharedCount.get(r.variant_id as string) ?? 0) + 1);
    const storeLocIds = new Set((locs ?? []).filter((l) => l.store_id === st.id).map((l) => l.id as string));
    for (const p of data.products.nodes) {
      for (const v of p.variants.nodes) {
        const appId = appOf.get(v.id) ?? null;
        const shopify = (v.inventoryItem?.inventoryLevels.nodes ?? []).map((l) => ({
          location: l.location.name, qty: l.quantities[0]?.quantity ?? 0, mapped: mappedLoc.has(l.location.id.split("/").pop()),
        }));
        const shopQty = shopify.filter((x) => x.mapped).reduce((s, x) => s + Math.max(0, x.qty), 0);
        const unitCount = appId ? (units ?? []).filter((u) => u.variant_id === appId && storeLocIds.has(u.location_id as string)).length : 0;
        const ex = appId ? (excess ?? []).find((e) => e.variant_id === appId) : undefined;
        const shared = appId ? sharedCount.get(appId) ?? 1 : 0;
        const reasons: string[] = [];
        if (!v.inventoryItem?.tracked) reasons.push("w Shopify bez śledzenia stanu – aplikacja takich nie liczy");
        if (!appId && v.inventoryItem?.tracked) reasons.push("rozmiar nie jest jeszcze w katalogu aplikacji – dojdzie przy odczycie katalogu (albo jest wykluczony w Ustawieniach)");
        if (shopify.some((x) => x.qty > 0 && !x.mapped)) reasons.push("część stanu leży w lokalizacji Shopify nieprzypisanej do lokalizacji aplikacji (Ustawienia → Stany)");
        if (shared > 1) reasons.push(`ten rozmiar był połączony z ${shared - 1} innym(i) produktem(ami) Shopify o tym samym SKU – aplikacja rozdziela je automatycznie przy odczycie katalogu`);
        if (ex) reasons.push(`różnica czeka na potwierdzenie od ${new Date(ex.first_seen_at as string).toLocaleString("pl-PL", { timeZone: "Europe/Warsaw" })} (sztuki dochodzą po ~10 min, znikają po ~30 min)`);
        if (!reasons.length && appId && shopQty !== unitCount) reasons.push("różnica wyrówna się przy najbliższym odczycie stanów (co 15 min albo „Sprawdź nowe produkty i stany”)");
        rows.push({
          store: st.name as string, product: p.title, productGid: p.id, status: p.status, tags: p.tags, variant: v.title, sku: v.sku,
          tracked: !!v.inventoryItem?.tracked, shopify, appVariantId: appId, shared, units: unitCount, waiting: ex ? String(ex.first_seen_at) : null, reasons,
        });
      }
    }
  }
  return { rows, errors };
}
