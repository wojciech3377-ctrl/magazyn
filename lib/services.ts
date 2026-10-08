/** Usługi (naprawy, wymiany) – nie są towarem, więc nie trafiają do magazynu ani do sprzedaży sztuk. */
export const SERVICE_SKU_PREFIXES = ["TF-SRV", "TF-OCHR"];

export function isServiceSku(sku: string | null | undefined) {
  const s = (sku ?? "").trim().toUpperCase();
  return !!s && SERVICE_SKU_PREFIXES.some((p) => s.startsWith(p));
}
