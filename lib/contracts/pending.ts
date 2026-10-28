/**
 * Pozycje umowy (skan / faktura), których jeszcze nie ma w magazynie: bez własnej sztuki (unit_id) i nie pokryte
 * sztuką tego samego rozmiaru przypiętą do umowy osobno (np. kodem). Zwraca indeks pozycji → ile sztuk brakuje.
 */
export function pendingContractItems(
  items: { unit_id?: string | null; variant_id?: string | null; qty?: number | string | null }[],
  units: { id: string; variant_id: string | null }[],
): Map<number, number> {
  const referenced = new Set(items.map((i) => i.unit_id).filter(Boolean) as string[]);
  const free = new Map<string, number>();
  for (const u of units) if (u.variant_id && !referenced.has(u.id)) free.set(u.variant_id, (free.get(u.variant_id) ?? 0) + 1);
  const out = new Map<number, number>();
  items.forEach((it, k) => {
    if (it.unit_id) return;
    const qty = Math.max(1, Math.floor(Number(it.qty ?? 1)) || 1);
    const have = it.variant_id ? Math.min(qty, free.get(it.variant_id) ?? 0) : 0;
    if (have) free.set(it.variant_id!, (free.get(it.variant_id!) ?? 0) - have);
    if (qty - have > 0) out.set(k, qty - have);
  });
  return out;
}
