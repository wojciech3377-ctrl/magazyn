/** Pozycje WTB tego samego modelu (ten sam produkt z katalogu albo ta sama nazwa i SKU) łączone w jedną kartę z listą rozmiarów. */

export type WtbRow = { id: string; title: string; size: string | null; sku: string | null; image_url: string | null; product_id?: string | null; note?: string | null; order_id?: string | null; created_at?: string; closed_at?: string | null };
export type WtbGroup<T extends WtbRow = WtbRow> = { key: string; title: string; sku: string | null; image_url: string | null; items: T[]; ids: string[]; sizes: string[] };

const collator = new Intl.Collator("pl", { numeric: true });
const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

export function wtbKey(r: WtbRow) {
  return r.product_id ? `p:${r.product_id}` : `t:${norm(r.title)}|${norm(r.sku)}`;
}

export function groupWtb<T extends WtbRow>(rows: T[]): WtbGroup<T>[] {
  const map = new Map<string, WtbGroup<T>>();
  for (const r of rows) {
    const key = wtbKey(r);
    let g = map.get(key);
    if (!g) {
      g = { key, title: r.title, sku: r.sku, image_url: r.image_url, items: [], ids: [], sizes: [] };
      map.set(key, g);
    }
    g.items.push(r);
    g.ids.push(r.id);
    if (!g.image_url && r.image_url) g.image_url = r.image_url;
  }
  for (const g of map.values()) {
    g.items.sort((a, b) => collator.compare(a.size ?? "", b.size ?? ""));
    g.sizes = [...new Set(g.items.map((i) => i.size).filter((s): s is string => !!s))];
  }
  return [...map.values()];
}

/** Lista rozmiarów: „40, 41,5; 42” albo „40,41,42” → osobne rozmiary; „41,5” (jedna cyfra po przecinku) zostaje jednym rozmiarem. */
export function parseSizes(text: string) {
  return [...new Set(text.split(/;|\n|,(?!\d(?:\D|$))/).map((s) => s.trim()).filter(Boolean))].slice(0, 30);
}
