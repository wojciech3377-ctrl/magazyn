"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { applyLinks, baseSyncChunk, baseSyncStart, importShopifyPage, suggestLinks } from "./actions";

type Store = { id: string; name: string; shopify_domain: string | null; base_inventory_id: number | null; base_storage_id: string | null };

export function SyncPanel({ stores }: { stores: Store[] }) {
  const router = useRouter();
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const say = (m: string) => setLog((l) => [...l.slice(-30), m]);

  async function run(task: () => Promise<void>) {
    setBusy(true);
    try {
      await task();
    } catch (e) {
      say(`Błąd: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  const importShopify = (s: Store) => run(async () => {
    if (!s.shopify_domain) throw new Error(`Ustaw domenę Shopify dla ${s.name} w Ustawieniach`);
    let cursor: string | null = null;
    let total = 0, created = 0, variants = 0;
    say(`${s.name}: import z Shopify…`);
    do {
      const r = await importShopifyPage(s.id, cursor);
      if (!r.ok) throw new Error(r.error);
      total += r.data.products; created += r.data.created; variants += r.data.variants;
      cursor = r.data.next;
      say(`${s.name}: ${total} produktów (${variants} rozmiarów, nowych ${created})`);
    } while (cursor);
    say(`${s.name}: import zakończony.`);
  });

  const syncBase = (s: Store) => run(async () => {
    if (!s.base_inventory_id) throw new Error(`Ustaw katalog Base dla ${s.name} w Ustawieniach`);
    say(`Base (katalog ${s.base_inventory_id}): pobieram listę produktów…`);
    const start = await baseSyncStart(s.base_inventory_id);
    if (!start.ok) throw new Error(start.error);
    say(`Base: ${start.data.total} produktów do pobrania (limit Base: 100 zapytań na minutę, to może chwilę potrwać).`);
    for (;;) {
      const r = await baseSyncChunk(s.base_inventory_id);
      if (!r.ok) throw new Error(r.error);
      say(`Base: ${r.data.processed} / ${r.data.total}`);
      if (r.data.done) break;
    }
    await linkStores(s.base_inventory_id);
  });

  async function linkStores(inventoryId: number) {
    for (const st of stores.filter((x) => x.base_inventory_id === inventoryId)) {
      const l = await applyLinks(st.id);
      if (!l.ok) throw new Error(l.error);
      say(`${st.name}: powiązane przez Base ${l.data.linked}, bez powiązania ${l.data.unlinked}${l.data.base_storage_id ? ` (sklep w Base: ${l.data.base_storage_id})` : " – nie wykryto sklepu w Base"}.`);
      let suggested = 0;
      for (;;) {
        const r = await suggestLinks(st.id);
        if (!r.ok) throw new Error(r.error);
        suggested += r.data.suggested;
        if (r.data.left === 0 || r.data.checked === 0) break;
        say(`${st.name}: szukam podpowiedzi, zostało ${r.data.left}…`);
      }
      say(`${st.name}: podpowiedzi do zatwierdzenia: ${suggested}.`);
    }
  }

  const relink = (s: Store) => run(async () => {
    if (!s.base_inventory_id) throw new Error(`Ustaw katalog Base dla ${s.name} w Ustawieniach`);
    await linkStores(s.base_inventory_id);
  });

  return (
    <section className="card mb-5 p-4">
      <h2 className="h2 mb-1">Synchronizacja</h2>
      <p className="mb-3 text-sm text-muted">Najpierw import z obu sklepów Shopify, potem katalog Base – aplikacja przepisze powiązania, które Base już ma, i podpowie resztę. Nowe produkty ze Shopify dochodzą potem same.</p>
      <div className="flex flex-wrap gap-2">
        {stores.map((s) => (
          <button key={`s${s.id}`} className="btn-secondary" disabled={busy} onClick={() => importShopify(s)}>Import z Shopify: {s.name}</button>
        ))}
        {[...new Map(stores.filter((s) => s.base_inventory_id).map((s) => [s.base_inventory_id, s])).values()].map((s) => (
          <span key={`b${s.id}`} className="contents">
            <button className="btn-secondary" disabled={busy} onClick={() => syncBase(s)}>Katalog Base {s.base_inventory_id} + powiązania</button>
            <button className="btn-secondary" disabled={busy} onClick={() => relink(s)}>Tylko powiązania {s.base_inventory_id}</button>
          </span>
        ))}
      </div>
      {log.length > 0 && <pre className="mt-3 max-h-48 overflow-auto rounded bg-panel p-3 text-xs leading-relaxed">{log.join("\n")}</pre>}
    </section>
  );
}
