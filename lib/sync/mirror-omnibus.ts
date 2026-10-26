import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { shopifyGraphql } from "@/lib/integrations/shopify";
import { errorMessage } from "@/lib/errors";
import { lowestFromHistory, storefrontLowest } from "@/lib/price-tag";
import { MIRROR_VARIANTS, mirrorPairs, optKey, recordShopPrices, SOURCE_QUERY, type MirrorPair, type SrcProduct } from "./mirror";

/**
 * Najniższa cena z 30 dni (Omnibus) w sklepie-kopii (np. Owca Store): z historii cen aplikacji (ceny sklepu źródłowego –
 * kopia ma te same ceny), zapisywana w metapolu rozmiaru `magazyn.lowest_price_30d` (liczba). Motyw sklepu pokazuje ją
 * pod ceną (fragment Liquid w Ustawieniach → Sklep-kopia).
 * Przy obniżce: najniższa z 30 dni przed obniżką; bez obniżki – najniższa z ostatnich 30 dni.
 */
export const OMNIBUS_NS = "magazyn";
export const OMNIBUS_KEY = "lowest_price_30d";

type VLink = { variant_id: string; shopify_variant_id: string; price: number | null };

/** Wartości dla rozmiarów kopii (ID Shopify kopii → najniższa cena). */
async function lowestFor(db: SupabaseClient, pair: MirrorPair, links: VLink[]) {
  const out = new Map<string, number>();
  const ids = [...new Set(links.map((l) => l.variant_id))];
  const hist: { variant_id: string; price: number; valid_from: string }[] = [];
  for (let i = 0; i < ids.length; i += 40) {
    const { data, error } = await db.from("variant_price_history").select("variant_id, price, valid_from")
      .eq("store_id", pair.source.id).in("variant_id", ids.slice(i, i + 40)).order("valid_from").limit(1000);
    if (error) throw error;
    hist.push(...((data ?? []) as typeof hist));
  }
  const byVariant = new Map<string, typeof hist>();
  for (const h of hist) byVariant.set(h.variant_id, [...(byVariant.get(h.variant_id) ?? []), h]);
  for (const l of links) {
    const rows = byVariant.get(l.variant_id) ?? [];
    if (!rows.length) continue;
    // Cena obecna – ostatnia z historii źródła (kopia ma te same ceny).
    const current = Number(rows[rows.length - 1].price);
    const r = lowestFromHistory(rows, current);
    if (r.value !== null && Number.isFinite(r.value)) out.set(l.shopify_variant_id, Math.round(r.value * 100) / 100);
  }
  return out;
}

async function setMetafields(pair: MirrorPair, values: Map<string, number>) {
  const list = [...values.entries()];
  let sent = 0;
  for (let i = 0; i < list.length; i += 25) {
    const d = await shopifyGraphql<{ metafieldsSet: { userErrors: { message: string }[] } }>(pair.mirror.shopify_domain, pair.mirror.code,
      `mutation OmSet($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { metafields { id } userErrors { field message } } }`,
      { m: list.slice(i, i + 25).map(([ownerId, v]) => ({ ownerId, namespace: OMNIBUS_NS, key: OMNIBUS_KEY, type: "number_decimal", value: v.toFixed(2) })) });
    const err = d.metafieldsSet.userErrors.map((e) => e.message).join("; ");
    if (err) throw new Error(`Shopify ${pair.mirror.name}: ${err}`);
    sent += Math.min(25, list.length - i);
  }
  return sent;
}

/** Jeden produkt (po skopiowaniu / zmianie ceny) – od razu. */
export async function mirrorOmnibusProduct(db: SupabaseClient, pair: MirrorPair, productId: string) {
  const { data: vs } = await db.from("variants").select("id").eq("product_id", productId);
  const ids = (vs ?? []).map((v) => v.id as string);
  if (!ids.length) return 0;
  const { data: links } = await db.from("variant_store_links").select("variant_id, shopify_variant_id, price").eq("store_id", pair.mirror.id).in("variant_id", ids);
  const values = await lowestFor(db, pair, (links ?? []) as VLink[]);
  return values.size ? setMetafields(pair, values) : 0;
}

/**
 * Codziennie (okno 30 dni się przesuwa): wszystkie produkty kopii, porcjami po 50 produktów z kursorem
 * (kolejne przebiegi automatu dokańczają; raz na dobę od nowa).
 */
export async function refreshMirrorOmnibus(db: SupabaseClient, opts: { deadline: number }) {
  const out: Record<string, unknown> = {};
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw" }).format(new Date());
  for (const pair of await mirrorPairs(db, true)) {
    const key = `omnibus_mirror:${pair.mirror.id}`;
    const { data: st } = await db.from("sync_state").select("value").eq("key", key).maybeSingle();
    let state = (st?.value as { day?: string; after?: string | null; done?: boolean; extrasDone?: boolean; extraAfter?: string } | null) ?? {};
    if (state.day !== today) state = { day: today, after: null, done: false, extrasDone: false };
    if (state.done && state.extrasDone) continue;
    let products = 0, sent = 0;
    try {
      while (Date.now() < opts.deadline) {
        let q = db.from("product_store_links").select("id, product_id").eq("store_id", pair.mirror.id).not("mirror_hash", "is", null).order("id").limit(50);
        if (state.after) q = q.gt("id", state.after);
        const { data: chunk, error } = await q;
        if (error) throw error;
        if (!chunk?.length) { state.done = true; break; }
        const pids = chunk.map((c) => c.product_id as string);
        const vids: string[] = [];
        for (let i = 0; i < pids.length; i += 50) {
          const { data } = await db.from("variants").select("id").in("product_id", pids.slice(i, i + 50));
          vids.push(...(data ?? []).map((v) => v.id as string));
        }
        const links: VLink[] = [];
        for (let i = 0; i < vids.length; i += 150) {
          const { data } = await db.from("variant_store_links").select("variant_id, shopify_variant_id, price").eq("store_id", pair.mirror.id).in("variant_id", vids.slice(i, i + 150));
          links.push(...((data ?? []) as VLink[]));
        }
        sent += await setMetafields(pair, await lowestFor(db, pair, links));
        products += chunk.length;
        state.after = String(chunk[chunk.length - 1].id);
        if (chunk.length < 50) { state.done = true; break; }
      }
      // Produkty spoza magazynu (np. Rope) – po produktach z magazynu, w tym samym dniu.
      let extras = 0;
      if (state.done && !state.extrasDone) {
        const { data: ex, error: exErr } = await db.from("mirror_extra").select("source_product_id, mirror_product_id").eq("store_id", pair.mirror.id).not("mirror_product_id", "is", null).order("source_product_id");
        const todo = (ex ?? []).filter((x) => !state.extraAfter || (x.source_product_id as string) > state.extraAfter);
        for (const x of exErr ? [] : todo) {
          if (Date.now() > opts.deadline) break;
          sent += await mirrorExtraOmnibus(db, pair, x.source_product_id as string, x.mirror_product_id as string).catch(() => 0);
          state.extraAfter = x.source_product_id as string;
          extras++;
        }
        if (exErr || extras === todo.length) state.extrasDone = true;
      }
      out[pair.mirror.name] = { produkty: products, ...(extras ? { spoza_magazynu: extras } : {}), ceny: sent, ...(state.done && state.extrasDone ? { gotowe: true } : {}) };
    } catch (e) {
      out[pair.mirror.name] = `błąd: ${errorMessage(e)}`;
    }
    await db.from("sync_state").upsert({ key, value: state, updated_at: new Date().toISOString() });
  }
  return out;
}

/**
 * Produkt spoza magazynu (np. Rope, SQL 79/80): najniższa cena z 30 dni z historii cen tego rozmiaru w sklepie źródłowym
 * (shop_price_history). Dopóki historia nie obejmuje 30 dni – kwota z bloku Omnibus na stronie produktu w sklepie
 * źródłowym (np. Omnibus Insight w Sneakers Depot), a gdy go nie ma – z dotychczasowej historii.
 */
export async function mirrorExtraOmnibus(db: SupabaseClient, pair: MirrorPair, sourceGid: string, mirrorGid: string) {
  const src = (await shopifyGraphql<{ product: SrcProduct | null }>(pair.source.shopify_domain, pair.source.code, SOURCE_QUERY, { id: sourceGid })).product;
  if (!src) return 0;
  await recordShopPrices(db, pair.source.id, src.variants.nodes).catch(() => false);
  type MV = { id: string; selectedOptions: { name: string; value: string }[] };
  const m = (await shopifyGraphql<{ product: { id: string; variants: { nodes: MV[] } } | null }>(pair.mirror.shopify_domain, pair.mirror.code, MIRROR_VARIANTS, { id: mirrorGid })).product;
  if (!m) return 0;
  const gids = src.variants.nodes.map((v) => v.id);
  const { data, error } = await db.from("shop_price_history").select("shopify_variant_id, price, valid_from")
    .eq("store_id", pair.source.id).in("shopify_variant_id", gids).order("valid_from").limit(1000);
  if (error) return 0; // bez SQL 80
  const hist = new Map<string, { variant_id: string; price: number; valid_from: string }[]>();
  for (const h of (data ?? []) as { shopify_variant_id: string; price: number; valid_from: string }[]) {
    hist.set(h.shopify_variant_id, [...(hist.get(h.shopify_variant_id) ?? []), { variant_id: h.shopify_variant_id, price: Number(h.price), valid_from: h.valid_from }]);
  }
  const byKey = new Map(m.variants.nodes.map((v) => [optKey(v.selectedOptions), v.id]));
  const first = src.variants.nodes[0];
  let shopValue: number | null | undefined;
  const values = new Map<string, number>();
  for (const v of src.variants.nodes) {
    const mid = byKey.get(optKey(v.selectedOptions));
    if (!mid) continue;
    const rows = hist.get(v.id) ?? [];
    const r = rows.length ? lowestFromHistory(rows, Number(v.price)) : { value: null as number | null, complete: false };
    let val = r.value;
    if (!r.complete && first && Number(v.price) === Number(first.price)) {
      if (shopValue === undefined) shopValue = await storefrontLowest(pair.source.shopify_domain, src.handle, first.id);
      if (shopValue !== null) val = shopValue;
    }
    if (val !== null && Number.isFinite(val)) values.set(mid, Math.round(val * 100) / 100);
  }
  return values.size ? setMetafields(pair, values) : 0;
}
