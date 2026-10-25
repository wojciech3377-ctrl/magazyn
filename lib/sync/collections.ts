import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { collectionProductPage, listCollections } from "@/lib/integrations/shopify";
import { errorMessage } from "@/lib/errors";

/**
 * Kolekcje (kategorie) ze Shopify → shop_collections / shop_collection_products → products.collections.
 * Pełny przebieg: lista kolekcji, potem produkty każdej kolekcji po kolei. Gdy skończy się czas albo limit zapytań
 * Shopify, kolejka zostaje w sync_state i następny odczyt kończy resztę.
 */

type State = { queue: string[]; doneAt: string | null; startedAt: string | null };
type Store = { id: string; name: string; code: string; shopify_domain: string };

const isMissingTable = (m: string) => /shop_collection|refresh_product_collections|schema cache/i.test(m);

export async function syncCollections(db: SupabaseClient, opts: { deadline: number; minAgeMs: number }) {
  const { data: stores } = await db.from("stores").select("*").not("shopify_domain", "is", null);
  const out: Record<string, string> = {};
  let touched = false;
  for (const store of (stores ?? []) as Store[]) {
    // Sklep-kopia: kategorie jak w sklepie źródłowym (te same produkty) – bez osobnych kolekcji.
    if ((store as { mirror_of?: string | null }).mirror_of) continue;
    const key = `collections:${store.id}`;
    const { data: st } = await db.from("sync_state").select("value").eq("key", key).maybeSingle();
    const state: State = { queue: [], doneAt: null, startedAt: null, ...((st?.value as Partial<State> | null) ?? {}) };
    const save = () => db.from("sync_state").upsert({ key, value: state, updated_at: new Date().toISOString() });
    try {
      if (!state.queue.length) {
        if (state.doneAt && Date.now() - Date.parse(state.doneAt) < opts.minAgeMs) { out[store.name] = "aktualne"; continue; }
        if (Date.now() > opts.deadline) { out[store.name] = "brak czasu"; continue; }
        // Nowy przebieg: lista kolekcji; usunięte w Shopify znikają razem z przypisaniami.
        const cols = await listCollections(store.shopify_domain, store.code);
        if (cols.length) {
          const { error } = await db.from("shop_collections").upsert(cols.map((c) => ({ store_id: store.id, gid: c.id, title: c.title.trim(), handle: c.handle })), { onConflict: "store_id,gid" });
          if (error) throw new Error(error.message);
        }
        const { data: existing } = await db.from("shop_collections").select("gid").eq("store_id", store.id);
        const live = new Set(cols.map((c) => c.id));
        const gone = (existing ?? []).map((e) => e.gid as string).filter((g) => !live.has(g));
        for (let i = 0; i < gone.length; i += 100) await db.from("shop_collections").delete().eq("store_id", store.id).in("gid", gone.slice(i, i + 100));
        if (gone.length) touched = true;
        state.queue = cols.map((c) => c.id);
        state.startedAt = new Date().toISOString();
        await save();
      }
      let done = 0;
      while (state.queue.length && Date.now() < opts.deadline) {
        const gid = state.queue[0];
        const ids: string[] = [];
        let after: string | null = null;
        let missing = false;
        for (let page = 0; page < 80; page++) {
          const r = await collectionProductPage(store.shopify_domain, store.code, gid, after);
          if (!r) { missing = true; break; }
          ids.push(...r.nodes.map((n) => n.id));
          if (!r.pageInfo.hasNextPage) break;
          after = r.pageInfo.endCursor;
        }
        if (missing) {
          await db.from("shop_collections").delete().eq("store_id", store.id).eq("gid", gid);
        } else {
          const { error } = await db.from("shop_collection_products").delete().eq("store_id", store.id).eq("collection_gid", gid);
          if (error) throw new Error(error.message);
          const uniq = [...new Set(ids)];
          for (let i = 0; i < uniq.length; i += 1000) {
            const { error: insErr } = await db.from("shop_collection_products").insert(uniq.slice(i, i + 1000).map((id) => ({ store_id: store.id, collection_gid: gid, shopify_product_id: id })));
            if (insErr) throw new Error(insErr.message);
          }
          await db.from("shop_collections").update({ products_count: uniq.length, synced_at: new Date().toISOString() }).eq("store_id", store.id).eq("gid", gid);
        }
        state.queue.shift();
        touched = true;
        done++;
        await save();
      }
      if (!state.queue.length) { state.doneAt = new Date().toISOString(); await save(); }
      out[store.name] = state.queue.length ? `${done} kolekcji, zostało ${state.queue.length}` : `${done} kolekcji – gotowe`;
    } catch (e) {
      const m = errorMessage(e);
      // Bez SQL 58 – po cichu pomijamy (filtr kategorii czeka na migrację).
      if (isMissingTable(m)) return { skipped: "brak SQL 58" };
      await save();
      out[store.name] = `błąd: ${m.slice(0, 200)}`;
    }
  }
  if (touched) {
    const { data, error } = await db.rpc("refresh_product_collections");
    out.__products = error ? `błąd: ${error.message}` : String(data ?? 0);
  }
  return out;
}
