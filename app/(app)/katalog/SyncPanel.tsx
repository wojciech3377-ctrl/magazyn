"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { importShopifyPage, shopifyImportFinish, shopifyImportStart } from "./actions";
import { errorMessage } from "@/lib/errors";

type Store = { id: string; name: string; shopify_domain: string | null };

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
      say(`Błąd: ${errorMessage(e)}`);
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
    const startedAt = await shopifyImportStart();
    do {
      const r = await importShopifyPage(s.id, cursor);
      if (!r.ok) throw new Error(r.error);
      total += r.data.products; created += r.data.created; variants += r.data.variants;
      cursor = r.data.next;
      say(`${s.name}: ${total} produktów (${variants} rozmiarów, nowych ${created})`);
    } while (cursor);
    const f = await shopifyImportFinish(s.id, startedAt);
    if (!f.ok) throw new Error(f.error);
    say(`${s.name}: import zakończony. Usunięte z katalogu (nie ma ich już w sklepie albo są usługą): ${f.data.removed_products} produktów.`);
  });

  return (
    <section className="card mb-5 p-4">
      <h2 className="h2 mb-1">Synchronizacja</h2>
      <p className="mb-3 text-sm text-muted">Pełny import produktów ze sklepu Shopify. Zwykle niepotrzebny – nowe i zmienione produkty dochodzą same (na żywo przez webhooki i co kilka minut).</p>
      <div className="flex flex-wrap gap-2">
        {stores.map((s) => (
          <button key={`s${s.id}`} className="btn-secondary" disabled={busy} onClick={() => importShopify(s)}>Import z Shopify: {s.name}</button>
        ))}
      </div>
      {log.length > 0 && <pre className="mt-3 max-h-48 overflow-auto rounded bg-panel p-3 text-xs leading-relaxed">{log.join("\n")}</pre>}
    </section>
  );
}
