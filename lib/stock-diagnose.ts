import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { shopifyGraphql } from "@/lib/integrations/shopify";
import { splitProductGids, type Store } from "@/lib/sync/catalog";
import { getStockMaster, pushStockToShopify } from "@/lib/sync/shopify-stock";

/**
 * „Dlaczego aplikacja pokazuje inny stan niż Shopify?” – dla produktów pasujących do wyszukiwania:
 * stan każdego rozmiaru w Shopify (po lokalizacjach) obok sztuk w aplikacji i przyczyną różnicy.
 */
export type DiagRow = {
  store: string; product: string; productGid: string; status: string; tags: string[];
  variant: string; sku: string | null; tracked: boolean;
  shopify: { location: string; locationId: string; qty: number; mapped: boolean }[];
  appVariantId: string | null; shared: number; units: number; waiting: string | null; reasons: string[];
};

type Q = { products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: { id: string; title: string; status: string; tags: string[]; variants: { nodes: { id: string; title: string; sku: string | null; inventoryItem: { id: string; tracked: boolean; inventoryLevels: { nodes: { location: { id: string; name: string }; quantities: { quantity: number }[] }[] } } | null }[] } }[] } };

export async function diagnoseStock(db: SupabaseClient, input: string): Promise<{ rows: DiagRow[]; errors: string[] }> {
  // Kod sztuki (S011056) → produkt tej sztuki (wyszukanie w Shopify po nazwie).
  let text = input;
  const no = /^S0*(\d{1,6})$/i.exec(input.trim())?.[1];
  if (no) {
    const { data: u } = await db.from("units").select("variant:variants(product:products(title))").eq("code", `S${no.padStart(6, "0")}`).maybeSingle();
    const title = (u?.variant as unknown as { product: { title: string } } | null)?.product.title;
    if (title) text = `title:"${title.replace(/"/g, "")}"`;
  }
  const { data: stores } = await db.from("stores").select("id, name, code, shopify_domain").not("shopify_domain", "is", null);
  const { data: locs } = await db.from("locations").select("id, name, store_id, active, shopify_location_id");
  const rows: DiagRow[] = [];
  const errors: string[] = [];
  for (const st of stores ?? []) {
    const data: Q = { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } };
    try {
      // Po 4 produkty na zapytanie (limit kosztu zapytania Shopify = 1000), do 40 produktów.
      let after: string | null = null;
      for (let page = 0; page < 10; page++) {
        const part: Q = await shopifyGraphql<Q>(st.shopify_domain as string, st.code as string,
          `query($q: String!, $after: String) { products(first: 4, query: $q, after: $after) { pageInfo { hasNextPage endCursor } nodes { id title status tags variants(first: 20) { nodes { id title sku inventoryItem { id tracked inventoryLevels(first: 3) { nodes { location { id name } quantities(names: ["available"]) { quantity } } } } } } } } }`,
          { q: text, after });
        data.products.nodes.push(...part.products.nodes);
        if (!part.products.pageInfo.hasNextPage) break;
        after = part.products.pageInfo.endCursor;
      }
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
          location: l.location.name, locationId: l.location.id, qty: l.quantities[0]?.quantity ?? 0, mapped: mappedLoc.has(l.location.id.split("/").pop()),
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
        if (!reasons.length && appId && shopQty !== unitCount) reasons.push("odczyt stanów jeszcze tego nie wyrównał – kliknij „Wyrównaj te produkty teraz”");
        rows.push({
          store: st.name as string, product: p.title, productGid: p.id, status: p.status, tags: p.tags, variant: v.title, sku: v.sku,
          tracked: !!v.inventoryItem?.tracked, shopify, appVariantId: appId, shared, units: unitCount, waiting: ex ? String(ex.first_seen_at) : null, reasons,
        });
      }
    }
  }
  return { rows, errors };
}

/**
 * „Wyrównaj te produkty teraz”: rozdziela połączone produkty Shopify z tym samym SKU i od razu (bez czekania na
 * potwierdzenie) ustawia liczbę sztuk znalezionych rozmiarów na stan z Shopify. Komisu nie rusza.
 */
export async function fixProductStock(db: SupabaseClient, text: string) {
  const first = await diagnoseStock(db, text);
  // Główny jest magazyn aplikacji: to aplikacja ma rację – stan tych rozmiarów idzie do Shopify, sztuki zostają.
  if ((await getStockMaster(db)) === "app") {
    const ids = new Set(first.rows.map((r) => r.appVariantId).filter((x): x is string => !!x));
    const pushed = ids.size ? await pushStockToShopify(db, 500, ids) : {};
    const totals = Object.entries(pushed).map(([store, v]) => ({ store, added: 0, removed: 0, pushed: typeof v === "object" && v ? Number((v as { changed?: number }).changed ?? 0) : 0 }));
    const errors = [...first.errors, ...Object.entries(pushed).flatMap(([store, v]) => (v && typeof v === "object" && "errors" in v ? [`${store}: ${((v as { errors: string[] }).errors).join("; ")}`] : typeof v === "string" ? [`${store}: ${v}`] : []))];
    return { split: 0, totals, errors, master: "app" as const };
  }
  const { data: stores } = await db.from("stores").select("*").not("shopify_domain", "is", null);
  let split = 0;
  const sharedVariants = [...new Set(first.rows.filter((r) => r.shared > 1 && r.appVariantId).map((r) => `${r.store}|${r.appVariantId}`))];
  for (const key of sharedVariants) {
    const [storeName, variantId] = key.split("|");
    const store = (stores ?? []).find((s) => s.name === storeName) as Store | undefined;
    if (!store) continue;
    const { data: v } = await db.from("variants").select("product_id").eq("id", variantId).maybeSingle();
    if (!v) continue;
    const { data: links } = await db.from("product_store_links").select("shopify_product_id").eq("store_id", store.id).eq("product_id", v.product_id);
    const gids = (links ?? []).map((l) => l.shopify_product_id as string).filter(Boolean)
      .sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
    if (gids.length > 1) split += await splitProductGids(db, store, gids);
  }
  const { rows, errors } = split ? await diagnoseStock(db, text) : first;
  const { data: locs } = await db.from("locations").select("id, store_id, shopify_location_id, created_at").eq("active", true).not("shopify_location_id", "is", null).order("created_at");
  const totals: { store: string; added: number; removed: number; pushed: number }[] = [];
  for (const st of stores ?? []) {
    const mine = (locs ?? []).filter((l) => l.store_id === st.id);
    const byShopLoc = new Map<string, string[]>();
    for (const l of mine) {
      const k = String(l.shopify_location_id).split("/").pop()!;
      byShopLoc.set(k, [...(byShopLoc.get(k) ?? []), l.id as string]);
    }
    const best = new Map<string, { variant_id: string; location_id: string; qty: number; count_locations: string[] }>();
    for (const r of rows.filter((x) => x.store === st.name && x.appVariantId && x.tracked)) {
      for (const lv of r.shopify) {
        const group = byShopLoc.get(lv.locationId.split("/").pop()!);
        if (!group) continue;
        const key = `${r.appVariantId}|${group[0]}`;
        const prev = best.get(key);
        if (!prev || prev.qty < lv.qty) best.set(key, { variant_id: r.appVariantId!, location_id: group[0], qty: Math.max(0, lv.qty), count_locations: group });
      }
    }
    if (!best.size) continue;
    const { data, error } = await db.rpc("reconcile_stock", {
      p_rows: [...best.values()], p_limit: 1000, p_source: `Shopify ${st.name}`, p_scope: null,
      p_confirm_minutes: 0, p_remove: true, p_surplus_minutes: 0, p_history_limit: 1000,
    });
    if (error) { errors.push(`${st.name}: ${error.message}`); continue; }
    const d = data as { created?: number; removed?: number; withdrawn?: number };
    totals.push({ store: st.name as string, added: d.created ?? 0, removed: (d.removed ?? 0) + (d.withdrawn ?? 0), pushed: 0 });
  }
  return { split, totals, errors, master: "shopify" as const };
}
