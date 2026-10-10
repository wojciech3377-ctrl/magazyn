import type { LineItem } from "@/lib/sync/shop-orders";

/** Linia sprzedaży przypisana do zamówienia (z Base albo utworzona ze Shopify). */
export type PieceSale = {
  id: string;
  variant_id: string | null;
  status: string;
  shopify_line_id?: string | null;
  shopify_line_index?: number | null;
};

export type Piece<S extends PieceSale> = {
  line: LineItem;
  lineIndex: number;
  n: number;              // która sztuka pozycji (0..ilość-1)
  variantId: string | null;
  sale: S | null;
  ref: string;            // <id zamówienia>|<id pozycji>|<sztuka> – do „Dołącz umowę”
};

/**
 * Każda sztuka pozycji zamówienia z jej linią sprzedaży: najpierw linie utworzone dla tej pozycji,
 * potem linie z Base o tym samym rozmiarze.
 */
export function matchPieces<S extends PieceSale>(orderId: string, lines: LineItem[], sales: S[], variantOf: (shopifyVariantId: string) => string | undefined) {
  const pool = [...sales];
  const pieces: Piece<S>[] = [];
  lines.forEach((line, lineIndex) => {
    if (line.service) return;
    const variantId = line.shopify_variant_id ? variantOf(line.shopify_variant_id) ?? null : null;
    for (let n = 0; n < Math.max(1, line.quantity); n++) {
      const idx = pool.findIndex((s) => s.shopify_line_id === line.id && s.shopify_line_index === n);
      pieces.push({ line, lineIndex, n, variantId, sale: idx >= 0 ? pool.splice(idx, 1)[0] : null, ref: `${orderId}|${line.id}|${n}` });
    }
  });
  for (const p of pieces) {
    if (p.sale || !p.variantId) continue;
    const idx = pool.findIndex((s) => !s.shopify_line_id && s.variant_id === p.variantId);
    if (idx >= 0) p.sale = pool.splice(idx, 1)[0];
  }
  return pieces;
}

/** „<id zamówienia>|<id pozycji>|<sztuka>” → części (albo null przy złym formacie). */
export function parsePieceRef(ref: string) {
  const [orderId, lineId, n] = ref.split("|");
  if (!/^[0-9a-f-]{36}$/i.test(orderId ?? "") || !lineId || !/^\d+$/.test(n ?? "")) return null;
  return { orderId, lineId, n: Number(n) };
}
