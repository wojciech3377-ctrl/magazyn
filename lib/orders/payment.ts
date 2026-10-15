/**
 * Płatność, której Shopify nie zwróci sam (pobranie, zwykły przelew / płatność ręczna) – przy zwrocie pieniądze
 * trzeba przelać klientowi samemu. Zwraca opis do komunikatu albo null (karta, BLIK, Przelewy24… – zwrot przez Shopify).
 */
export function manualPayment(o: { cod?: boolean | null; payment_gateways?: string[] | null }): string | null {
  const g = (o.payment_gateways ?? []).join(" ");
  if (o.cod || /cash on delivery|pobrani|\bcod\b/i.test(g)) return "za pobraniem";
  if (/shopify_payments|przelewy24|\bp24\b|payu|stripe|paypal|blik|card|karta|tpay|klarna|apple|google/i.test(g)) return null;
  if (/bank|przelew|transfer|deposit|manual|wire/i.test(g)) return "przelewem tradycyjnym";
  return null;
}
