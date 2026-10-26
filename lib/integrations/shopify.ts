import "server-only";
import crypto from "node:crypto";

export const SHOPIFY_API_VERSION = "2026-07";

function envKey(storeCode: string) {
  return storeCode.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

export function shopifyCredentials(storeCode: string) {
  const k = envKey(storeCode);
  return {
    clientId: process.env[`SHOPIFY_${k}_CLIENT_ID`],
    clientSecret: process.env[`SHOPIFY_${k}_CLIENT_SECRET`],
    envNames: [`SHOPIFY_${k}_CLIENT_ID`, `SHOPIFY_${k}_CLIENT_SECRET`],
  };
}

const tokenCache = new Map<string, { token: string; expires: number }>();

/** Token Admin API przez client credentials (aplikacja z Dev Dashboard, ważny 24 h). */
export async function shopifyToken(domain: string, storeCode: string) {
  const cached = tokenCache.get(domain);
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const { clientId, clientSecret, envNames } = shopifyCredentials(storeCode);
  if (!clientId || !clientSecret) throw new Error(`Brak ${envNames.join(" / ")} w ustawieniach serwera`);
  const res = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
    cache: "no-store",
  });
  if (!res.ok) {
    // Odpowiedź Shopify (np. invalid_client, shop_not_permitted) – bez sekretów, pomaga ustalić przyczynę.
    const text = await res.text();
    const title = text.match(/<title>([^<]+)<\/title>/i)?.[1];
    const detail = (title ?? text).replace(/\s+/g, " ").slice(0, 300);
    throw new Error(`Shopify ${domain}: nie udało się pobrać tokenu (${res.status}): ${detail}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache.set(domain, { token: data.access_token, expires: Date.now() + data.expires_in * 1000 });
  return data.access_token;
}

export async function shopifyGraphql<T>(domain: string, storeCode: string, query: string, variables: Record<string, unknown> = {}) {
  const token = await shopifyToken(domain, storeCode);
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`https://${domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables }),
      cache: "no-store",
    });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    const body = (await res.json()) as { data?: T; errors?: { message: string; extensions?: { code?: string } }[] };
    if (body.errors?.some((e) => e.extensions?.code === "THROTTLED")) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    if (!res.ok || body.errors?.length) {
      throw new Error(`Shopify ${domain}: ${body.errors?.map((e) => e.message).join("; ") ?? res.status}`);
    }
    return body.data as T;
  }
  throw new Error(`Shopify ${domain}: przekroczony limit zapytań`);
}

export type ShopifyProduct = {
  tags?: string[];
  id: string;
  title: string;
  handle: string;
  vendor: string | null;
  productType: string | null;
  status: string;
  featuredMedia: { preview: { image: { url: string } | null } | null } | null;
  variants: {
    nodes: {
      id: string;
      title: string;
      sku: string | null;
      barcode: string | null;
      position: number;
      price: string | null;
      compareAtPrice?: string | null;
      inventoryItem: { id: string; tracked: boolean } | null;
    }[];
  };
};

const PRODUCT_FIELDS = `
  id title handle vendor productType status tags
  featuredMedia { preview { image { url } } }
  variants(first: 250) { nodes { id title sku barcode position price compareAtPrice inventoryItem { id tracked } } }
`;

export async function* iterateProducts(domain: string, storeCode: string) {
  let after: string | null = null;
  for (;;) {
    const data: { products: { nodes: ShopifyProduct[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } =
      await shopifyGraphql(domain, storeCode, `query($after: String) { products(first: 50, after: $after) { nodes { ${PRODUCT_FIELDS} } pageInfo { hasNextPage endCursor } } }`, { after });
    for (const p of data.products.nodes) yield p;
    if (!data.products.pageInfo.hasNextPage) break;
    after = data.products.pageInfo.endCursor;
  }
}

export async function getProduct(domain: string, storeCode: string, id: string) {
  const data = await shopifyGraphql<{ product: ShopifyProduct | null }>(domain, storeCode, `query($id: ID!) { product(id: $id) { ${PRODUCT_FIELDS} } }`, { id });
  return data.product;
}

/** Webhooki „na żywo”: produkty, zamówienia (z anulowaniem i zwrotami) i stany magazynowe. */
export const WEBHOOK_TOPICS = ["PRODUCTS_CREATE", "PRODUCTS_UPDATE", "PRODUCTS_DELETE", "ORDERS_CREATE", "ORDERS_UPDATED", "REFUNDS_CREATE", "INVENTORY_LEVELS_UPDATE"];

export async function registerProductWebhooks(domain: string, storeCode: string, callbackUrl: string) {
  const results: string[] = [];
  for (const topic of WEBHOOK_TOPICS) {
    const data = await shopifyGraphql<{
      webhookSubscriptionCreate: { userErrors: { message: string }[]; webhookSubscription: { id: string } | null };
    }>(
      domain,
      storeCode,
      `mutation($topic: WebhookSubscriptionTopic!, $url: String!) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: { uri: $url, format: JSON }) {
          webhookSubscription { id } userErrors { message }
        }
      }`,
      { topic, url: callbackUrl },
    );
    const err = data.webhookSubscriptionCreate.userErrors.map((e) => e.message).join("; ");
    results.push(`${topic}: ${err ? (/taken|already/i.test(err) ? "już włączony" : err) : "ok"}`);
  }
  return results;
}

/** Webhooki aplikacji w sklepie (tylko te na adres tej aplikacji, jeśli podano). */
export async function listWebhooks(domain: string, storeCode: string, uriPart?: string) {
  const data = await shopifyGraphql<{ webhookSubscriptions: { nodes: { id: string; topic: string; uri: string }[] } }>(
    domain, storeCode, `query { webhookSubscriptions(first: 100) { nodes { id topic uri } } }`,
  );
  return data.webhookSubscriptions.nodes.filter((n) => !uriPart || n.uri.includes(uriPart));
}

export async function deleteWebhooks(domain: string, storeCode: string, ids: string[]) {
  const errors: string[] = [];
  for (const id of ids) {
    const data = await shopifyGraphql<{ webhookSubscriptionDelete: { userErrors: { message: string }[] } }>(
      domain, storeCode,
      `mutation Del($id: ID!) { webhookSubscriptionDelete(id: $id) { deletedWebhookSubscriptionId userErrors { message } } }`,
      { id },
    );
    errors.push(...data.webhookSubscriptionDelete.userErrors.map((e) => e.message));
  }
  return errors;
}

export function verifyWebhook(rawBody: string, hmacHeader: string | null, storeCode: string) {
  const { clientSecret } = shopifyCredentials(storeCode);
  if (!clientSecret || !hmacHeader) return false;
  const digest = crypto.createHmac("sha256", clientSecret).update(rawBody, "utf8").digest("base64");
  const a = Buffer.from(digest);
  const b = Buffer.from(hmacHeader);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Numer z gid://shopify/ProductVariant/123 → "123". */
export function gidNumber(gid: string) {
  return gid.split("/").pop() ?? gid;
}

export type ShopifyOrder = {
  id: string;
  legacyResourceId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  cancelledAt: string | null;
  closedAt: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  paymentGatewayNames: string[];
  email: string | null;
  phone: string | null;
  note: string | null;
  customAttributes: { key: string; value: string | null }[];
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  totalOutstandingSet: { shopMoney: { amount: string } } | null;
  billingAddress: { name: string | null } | null;
  shippingAddress: {
    name: string | null; firstName: string | null; lastName: string | null; company: string | null;
    address1: string | null; address2: string | null; city: string | null; zip: string | null; countryCodeV2: string | null; phone: string | null;
  } | null;
  shippingLine: { title: string; code: string | null; source: string | null; originalPriceSet: { shopMoney: { amount: string } }; discountedPriceSet?: { shopMoney: { amount: string } } | null } | null;
  lineItems: {
    nodes: {
      id: string; title: string; variantTitle: string | null; sku: string | null; quantity: number;
      image: { url: string } | null; variant: { id: string } | null; originalUnitPriceSet: { shopMoney: { amount: string } };
      discountedUnitPriceAfterAllDiscountsSet?: { shopMoney: { amount: string } } | null;
    }[];
  };
  fulfillments: {
    id: string; status: string; displayStatus: string | null; createdAt: string; updatedAt: string;
    trackingInfo: { number: string | null; company: string | null; url: string | null }[];
  }[];
  returnStatus?: string | null;
  refunds?: {
    createdAt: string;
    refundLineItems: { nodes: { quantity: number; lineItem: { id: string } | null }[] };
    transactions: { nodes: { kind: string; status: string; amountSet: { shopMoney: { amount: string } } }[] };
  }[];
};

const ORDER_FIELDS = `
  id legacyResourceId name createdAt updatedAt cancelledAt closedAt
  displayFinancialStatus displayFulfillmentStatus paymentGatewayNames
  email phone note
  customAttributes { key value }
  totalPriceSet { shopMoney { amount currencyCode } }
  totalOutstandingSet { shopMoney { amount } }
  billingAddress { name }
  shippingAddress { name firstName lastName company address1 address2 city zip countryCodeV2 phone }
  shippingLine { title code source originalPriceSet { shopMoney { amount } } discountedPriceSet { shopMoney { amount } } }
  lineItems(first: 50) { nodes { id title variantTitle sku quantity image { url } variant { id } originalUnitPriceSet { shopMoney { amount } } discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount } } } }
  fulfillments(first: 10) { id status displayStatus createdAt updatedAt trackingInfo(first: 5) { number company url } }
  returnStatus
  refunds(first: 20) { createdAt refundLineItems(first: 50) { nodes { quantity lineItem { id } } } transactions(first: 10) { nodes { kind status amountSet { shopMoney { amount } } } } }
`;

/** Zamówienia zmienione od podanej chwili (rosnąco po dacie zmiany), po 50 na stronę. */
export async function ordersUpdatedSince(domain: string, storeCode: string, sinceIso: string, after: string | null) {
  const data = await shopifyGraphql<{
    orders: { nodes: ShopifyOrder[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
  }>(
    domain,
    storeCode,
    `query($q: String!, $after: String) { orders(first: 50, after: $after, query: $q, sortKey: UPDATED_AT) { nodes { ${ORDER_FIELDS} } pageInfo { hasNextPage endCursor } } }`,
    { q: `updated_at:>='${sinceIso}'`, after },
  );
  return data.orders;
}

/** Ostatnio zmienione zamówienia (do odczytu „na żywo”, gdy aplikacja jest otwarta). */
export async function recentOrders(domain: string, storeCode: string, first = 5) {
  const data = await shopifyGraphql<{ orders: { nodes: ShopifyOrder[] } }>(domain, storeCode,
    `query($first: Int!) { orders(first: $first, sortKey: UPDATED_AT, reverse: true) { nodes { ${ORDER_FIELDS} } } }`, { first });
  return data.orders.nodes;
}

export async function getOrder(domain: string, storeCode: string, id: string) {
  const data = await shopifyGraphql<{ order: ShopifyOrder | null }>(domain, storeCode, `query($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`, { id });
  return data.order;
}

/**
 * Oznacza zamówienie jako wysłane w Shopify z numerem przesyłki (klient dostaje e-mail ze śledzeniem).
 * Wymaga uprawnienia write_merchant_managed_fulfillment_orders w aplikacji sklepu.
 */
export async function fulfillWithTracking(
  domain: string,
  storeCode: string,
  orderId: string,
  tracking: { number: string; url: string | null; company: string },
  notifyCustomer: boolean,
  /** Paczka z częścią zamówienia: ID pozycji zamówienia (LineItem) → sztuk. Bez – wszystko, co jeszcze nie wysłane. */
  lines?: Record<string, number> | null,
) {
  type FoLine = { id: string; remainingQuantity: number; lineItem: { id: string } };
  const fo = await shopifyGraphql<{ order: { fulfillmentOrders: { nodes: { id: string; status: string; lineItems: { nodes: FoLine[] } }[] } } | null }>(
    domain,
    storeCode,
    `query($id: ID!) { order(id: $id) { fulfillmentOrders(first: 10) { nodes { id status lineItems(first: 250) { nodes { id remainingQuantity lineItem { id } } } } } } }`,
    { id: orderId },
  );
  const open = (fo.order?.fulfillmentOrders.nodes ?? []).filter((n) => n.status === "OPEN" || n.status === "IN_PROGRESS");
  if (!open.length) return "brak otwartych pozycji do wysłania w Shopify";
  // Częściowa wysyłka: tylko wybrane pozycje (i najwyżej tyle sztuk, ile jeszcze nie wysłano).
  let byFo: { fulfillmentOrderId: string; fulfillmentOrderLineItems?: { id: string; quantity: number }[] }[] = open.map((n) => ({ fulfillmentOrderId: n.id }));
  if (lines && Object.keys(lines).length) {
    const want = new Map(Object.entries(lines).map(([k, v]) => [k, Math.max(0, Math.floor(Number(v) || 0))]));
    byFo = open.map((n) => ({
      fulfillmentOrderId: n.id,
      fulfillmentOrderLineItems: n.lineItems.nodes.flatMap((li) => {
        const left = want.get(li.lineItem.id) ?? 0;
        const q = Math.min(left, li.remainingQuantity);
        if (q <= 0) return [];
        want.set(li.lineItem.id, left - q);
        return [{ id: li.id, quantity: q }];
      }),
    })).filter((x) => x.fulfillmentOrderLineItems.length);
    if (!byFo.length) return "wybrane pozycje są już wysłane w Shopify";
  }
  const data = await shopifyGraphql<{ fulfillmentCreate: { fulfillment: { id: string } | null; userErrors: { message: string }[] } }>(
    domain,
    storeCode,
    `mutation($f: FulfillmentInput!) { fulfillmentCreate(fulfillment: $f) { fulfillment { id status } userErrors { field message } } }`,
    {
      f: {
        lineItemsByFulfillmentOrder: byFo,
        trackingInfo: { number: tracking.number, company: tracking.company, ...(tracking.url ? { url: tracking.url } : {}) },
        notifyCustomer,
      },
    },
  );
  const err = data.fulfillmentCreate.userErrors.map((e) => e.message).join("; ");
  if (err) throw new Error(`Shopify: ${err}`);
  return null;
}

/**
 * Zamówienie oznaczone w Shopify jako wysłane bez numeru przesyłki (np. ręcznie) – dopisanie numeru do tej realizacji.
 * true = dopisano, false = nie ma realizacji bez numeru.
 */
export async function addTrackingToFulfillment(
  domain: string,
  storeCode: string,
  orderId: string,
  tracking: { number: string; url: string | null; company: string },
  notifyCustomer: boolean,
) {
  const o = await shopifyGraphql<{ order: { fulfillments: { id: string; status: string; trackingInfo: { number: string | null }[] }[] } | null }>(
    domain, storeCode,
    `query($id: ID!) { order(id: $id) { fulfillments(first: 10) { id status trackingInfo { number } } } }`,
    { id: orderId },
  );
  const all = o.order?.fulfillments ?? [];
  if (all.some((f) => f.trackingInfo.some((t) => t.number === tracking.number))) return true;
  const bare = all.find((f) => f.status === "SUCCESS" && !f.trackingInfo.some((t) => t.number));
  if (!bare) return false;
  const data = await shopifyGraphql<{ fulfillmentTrackingInfoUpdate: { userErrors: { message: string }[] } }>(
    domain, storeCode,
    `mutation($id: ID!, $t: FulfillmentTrackingInput!, $n: Boolean) { fulfillmentTrackingInfoUpdate(fulfillmentId: $id, trackingInfoInput: $t, notifyCustomer: $n) { fulfillment { id } userErrors { field message } } }`,
    { id: bare.id, t: { number: tracking.number, company: tracking.company, ...(tracking.url ? { url: tracking.url } : {}) }, n: notifyCustomer },
  );
  const err = data.fulfillmentTrackingInfoUpdate.userErrors.map((e) => e.message).join("; ");
  if (err) throw new Error(`Shopify: ${err}`);
  return true;
}

/** Otwarte pozycje do realizacji (fulfillment orders) zamówienia – z rodzajem dostawy (PICK_UP = odbiór osobisty). */
async function openFulfillmentOrders(domain: string, storeCode: string, orderId: string) {
  const fo = await shopifyGraphql<{ order: { fulfillmentOrders: { nodes: { id: string; status: string; deliveryMethod: { methodType: string } | null }[] } } | null }>(
    domain,
    storeCode,
    `query($id: ID!) { order(id: $id) { fulfillmentOrders(first: 10) { nodes { id status deliveryMethod { methodType } } } } }`,
    { id: orderId },
  );
  return (fo.order?.fulfillmentOrders.nodes ?? []).filter((n) => n.status === "OPEN" || n.status === "IN_PROGRESS");
}

/**
 * Odbiór osobisty: „Gotowe do odbioru” w Shopify – Shopify sam wysyła klientowi e-mail (powiadomienie „Gotowe do odbioru”).
 * Wymaga uprawnienia aplikacji write_merchant_managed_fulfillment_orders.
 */
export async function markReadyForPickup(domain: string, storeCode: string, orderId: string) {
  const open = await openFulfillmentOrders(domain, storeCode, orderId);
  const pickup = open.filter((n) => n.deliveryMethod?.methodType === "PICK_UP");
  if (!open.length) return "W Shopify nie ma otwartych pozycji – zamówienie jest już zrealizowane albo anulowane.";
  if (!pickup.length) return "W Shopify to zamówienie nie ma dostawy „odbiór osobisty” – zmień sposób dostawy w Shopify albo użyj etykiety.";
  const data = await shopifyGraphql<{ fulfillmentOrderLineItemsPreparedForPickup: { userErrors: { message: string }[] } }>(
    domain,
    storeCode,
    `mutation($input: FulfillmentOrderLineItemsPreparedForPickupInput!) {
      fulfillmentOrderLineItemsPreparedForPickup(input: $input) { userErrors { field message } }
    }`,
    { input: { lineItemsByFulfillmentOrder: pickup.map((n) => ({ fulfillmentOrderId: n.id })) } },
  );
  const err = data.fulfillmentOrderLineItemsPreparedForPickup.userErrors.map((e) => e.message).join("; ");
  if (err) throw new Error(`Shopify: ${err}`);
  return null;
}

/** Odbiór osobisty: klient odebrał – realizacja w Shopify bez numeru przesyłki (bez dodatkowego e-maila). */
export async function markPickedUp(domain: string, storeCode: string, orderId: string) {
  const open = await openFulfillmentOrders(domain, storeCode, orderId);
  if (!open.length) return "W Shopify nie ma otwartych pozycji – zamówienie jest już zrealizowane.";
  const data = await shopifyGraphql<{ fulfillmentCreate: { userErrors: { message: string }[] } }>(
    domain,
    storeCode,
    `mutation($f: FulfillmentInput!) { fulfillmentCreate(fulfillment: $f) { fulfillment { id } userErrors { field message } } }`,
    { f: { lineItemsByFulfillmentOrder: open.map((n) => ({ fulfillmentOrderId: n.id })), notifyCustomer: false } },
  );
  const err = data.fulfillmentCreate.userErrors.map((e) => e.message).join("; ");
  if (err) throw new Error(`Shopify: ${err}`);
  return null;
}

export type CancelReason = "CUSTOMER" | "DECLINED" | "FRAUD" | "INVENTORY" | "OTHER" | "STAFF";

/**
 * Anulowanie zamówienia w Shopify (nieodwracalne). restock = false – sztuki wracają na stan w aplikacji,
 * a aplikacja zmienia stan w Shopify. Wymaga uprawnienia write_orders.
 */
export async function cancelShopifyOrder(
  domain: string,
  storeCode: string,
  orderId: string,
  opts: { reason: CancelReason; refund: boolean; notify: boolean; note?: string },
) {
  const data = await shopifyGraphql<{ orderCancel: { job: { id: string; done: boolean } | null; orderCancelUserErrors: { message: string }[] } }>(
    domain,
    storeCode,
    `mutation Cancel($id: ID!, $reason: OrderCancelReason!, $refund: OrderCancelRefundMethodInput, $notify: Boolean, $note: String) {
      orderCancel(orderId: $id, reason: $reason, refundMethod: $refund, restock: false, notifyCustomer: $notify, staffNote: $note) {
        job { id done } orderCancelUserErrors { field message code }
      }
    }`,
    {
      id: orderId,
      reason: opts.reason,
      refund: opts.refund ? { originalPaymentMethodsRefund: true } : null,
      notify: opts.notify,
      note: opts.note?.slice(0, 255) || null,
    },
  );
  const err = data.orderCancel.orderCancelUserErrors.map((e) => e.message).join("; ");
  if (err) throw new Error(`Shopify: ${err}`);
}

/**
 * Zwrot pozycji: zwrot pieniędzy na oryginalną metodę płatności (kwotę liczy Shopify),
 * opcjonalnie z kosztem wysyłki. Bez zwrotu pieniędzy zapisuje tylko zwrócone pozycje.
 */
export async function refundShopifyLines(
  domain: string,
  storeCode: string,
  orderId: string,
  lines: { lineItemId: string; quantity: number }[],
  opts: { refundMoney: boolean; shipping: boolean; notify: boolean; note?: string; amount?: number | null; keepGoods?: boolean; key?: string },
) {
  const refundLineItems = lines.map((l) => ({ lineItemId: l.lineItemId, quantity: l.quantity, restockType: "NO_RESTOCK" }));
  let transactions: { orderId: string; gateway: string; kind: "REFUND"; amount: string; parentId: string | null }[] = [];
  let amount = 0;
  if (opts.refundMoney && opts.amount && opts.amount > 0) {
    // Własna kwota: rozkład na pobrane płatności (najpierw największa możliwa do zwrotu).
    const t = await shopifyGraphql<{ order: { transactions: { id: string; kind: string; status: string; gateway: string; maximumRefundableV2: { amount: string } | null }[] } | null }>(
      domain,
      storeCode,
      `query Tx($id: ID!) { order(id: $id) { transactions(first: 30) { id kind status gateway maximumRefundableV2 { amount } } } }`,
      { id: orderId },
    );
    const paid = (t.order?.transactions ?? [])
      .filter((x) => (x.kind === "SALE" || x.kind === "CAPTURE") && x.status === "SUCCESS" && Number(x.maximumRefundableV2?.amount ?? 0) > 0)
      .sort((a, b) => Number(b.maximumRefundableV2!.amount) - Number(a.maximumRefundableV2!.amount));
    let left = Math.round(opts.amount * 100) / 100;
    const max = paid.reduce((s2, x) => s2 + Number(x.maximumRefundableV2!.amount), 0);
    if (max <= 0) throw new Error("Shopify nie może sam zwrócić pieniędzy za to zamówienie (np. za pobraniem albo przelew ręczny) – odznacz „Zwróć pieniądze” i oddaj je ręcznie.");
    if (left > max + 0.001) throw new Error(`Do zwrotu zostało najwyżej ${max.toFixed(2)} zł.`);
    for (const x of paid) {
      if (left <= 0) break;
      const part = Math.min(left, Number(x.maximumRefundableV2!.amount));
      transactions.push({ orderId, gateway: x.gateway, kind: "REFUND", amount: part.toFixed(2), parentId: x.id });
      left = Math.round((left - part) * 100) / 100;
    }
    amount = opts.amount;
  } else if (opts.refundMoney) {
    const s = await shopifyGraphql<{
      order: { suggestedRefund: { amountSet: { shopMoney: { amount: string } }; suggestedTransactions: { gateway: string | null; amountSet: { shopMoney: { amount: string } }; parentTransaction: { id: string } | null }[] } } | null;
    }>(
      domain,
      storeCode,
      `query Suggest($id: ID!, $lines: [RefundLineItemInput!], $ship: Boolean) {
        order(id: $id) { suggestedRefund(refundLineItems: $lines, refundShipping: $ship) {
          amountSet { shopMoney { amount currencyCode } }
          suggestedTransactions { gateway kind amountSet { shopMoney { amount } } parentTransaction { id } }
        } }
      }`,
      { id: orderId, lines: refundLineItems, ship: opts.shipping },
    );
    const sug = s.order?.suggestedRefund;
    amount = Number(sug?.amountSet.shopMoney.amount ?? 0);
    transactions = (sug?.suggestedTransactions ?? [])
      .filter((t) => t.gateway && Number(t.amountSet.shopMoney.amount) > 0)
      .map((t) => ({ orderId, gateway: t.gateway!, kind: "REFUND", amount: t.amountSet.shopMoney.amount, parentId: t.parentTransaction?.id ?? null }));
  }
  const data = await shopifyGraphql<{ refundCreate: { refund: { id: string; totalRefundedSet: { shopMoney: { amount: string } } } | null; userErrors: { message: string }[] } }>(
    domain,
    storeCode,
    `mutation Refund($input: RefundInput!, $key: String!) {
      refundCreate(input: $input) @idempotent(key: $key) { refund { id totalRefundedSet { shopMoney { amount } } } userErrors { field message } }
    }`,
    {
      // Ten sam klucz przy ponownym wysłaniu formularza = Shopify nie zwróci pieniędzy drugi raz.
      key: opts.key || crypto.randomUUID(),
      input: {
        orderId,
        notify: opts.notify,
        note: opts.note || null,
        // Towar zostaje u klienta: same pieniądze (kwota z pozycji policzona wyżej), bez oznaczania pozycji jako zwróconych.
        refundLineItems: opts.keepGoods ? [] : refundLineItems,
        ...(opts.shipping ? { shipping: { fullRefund: true } } : {}),
        ...(transactions.length ? { transactions } : {}),
      },
    },
  );
  const err = data.refundCreate.userErrors.map((e) => e.message).join("; ");
  if (err) throw new Error(`Shopify: ${err}`);
  return { refunded: Number(data.refundCreate.refund?.totalRefundedSet.shopMoney.amount ?? 0), suggested: amount, moneyBack: transactions.length > 0 };
}

/** Produkty zmienione od podanej chwili (rosnąco po dacie zmiany), po 50 – nowe i zmienione ceny. */
export async function productsUpdatedSince(domain: string, storeCode: string, sinceIso: string, after: string | null) {
  const data = await shopifyGraphql<{ products: { nodes: (ShopifyProduct & { updatedAt: string })[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }>(
    domain,
    storeCode,
    `query($q: String!, $after: String) { products(first: 50, after: $after, query: $q, sortKey: UPDATED_AT) { nodes { updatedAt ${PRODUCT_FIELDS} } pageInfo { hasNextPage endCursor } } }`,
    { q: `updated_at:>='${sinceIso}'`, after },
  );
  return data.products;
}

/**
 * Metapola produktu i jego rozmiarów, które wyglądają na dane aplikacji Omnibus (najniższa cena z 30 dni).
 * Aplikacje trzymające dane w prywatnych metapolach ($app) nie są tu widoczne.
 */
export async function omnibusMetafields(domain: string, storeCode: string, productGid: string) {
  const data = await shopifyGraphql<{ product: { metafields: { nodes: Mf[] }; variants: { nodes: { id: string; metafields: { nodes: Mf[] } }[] } } | null }>(domain, storeCode,
    `query($id: ID!) { product(id: $id) { metafields(first: 50) { nodes { namespace key type value } } variants(first: 100) { nodes { id metafields(first: 30) { nodes { namespace key type value } } } } } }`, { id: productGid });
  const pick = (list: Mf[]) => list.filter((m) => /omnibus|amasty|lowest|najni|min_price|price_history/i.test(`${m.namespace}.${m.key}`));
  return {
    product: pick(data.product?.metafields.nodes ?? []),
    variants: new Map((data.product?.variants.nodes ?? []).map((v) => [v.id, pick(v.metafields.nodes)])),
  };
}
type Mf = { namespace: string; key: string; type: string; value: string };

/** Wszystkie zdjęcia produktu (media) – do galerii w karcie sztuki. */
export async function productMedia(domain: string, storeCode: string, productGid: string) {
  const data = await shopifyGraphql<{ product: { media: { nodes: { alt: string | null; preview: { image: { url: string; width: number | null; height: number | null } | null } | null }[] } } | null }>(domain, storeCode,
    `query($id: ID!) { product(id: $id) { media(first: 50) { nodes { alt preview { image { url width height } } } } } }`, { id: productGid });
  return (data.product?.media.nodes ?? []).map((m) => m.preview?.image ? { url: m.preview.image.url, alt: m.alt ?? null, w: m.preview.image.width, h: m.preview.image.height } : null).filter((x): x is { url: string; alt: string | null; w: number | null; h: number | null } => !!x);
}

/** Definicje metapól wyglądające na najniższą cenę z 30 dni (np. „Lowest price” z Omnibus Insight). */
export async function lowestPriceDefinitions(domain: string, storeCode: string) {
  const data = await shopifyGraphql<{ v: { nodes: Def[] }; p: { nodes: Def[] } }>(domain, storeCode,
    `query { v: metafieldDefinitions(first: 250, ownerType: PRODUCTVARIANT) { nodes { name namespace key } } p: metafieldDefinitions(first: 250, ownerType: PRODUCT) { nodes { name namespace key } } }`);
  const pick = (list: Def[]) => list.filter((d) => /lowest|najni|omnibus/i.test(`${d.name} ${d.namespace} ${d.key}`));
  return { variant: pick(data.v.nodes), product: pick(data.p.nodes) };
}
type Def = { name: string; namespace: string; key: string };

/** Konkretne metapola (z definicji) produktu i jego rozmiarów. */
export async function readMetafields(domain: string, storeCode: string, productGid: string, defs: { variant: Def[]; product: Def[] }) {
  if (!defs.variant.length && !defs.product.length) return { product: [] as Mf[], variants: new Map<string, Mf[]>() };
  const pf = defs.product.map((d, i) => `p${i}: metafield(namespace: ${JSON.stringify(d.namespace)}, key: ${JSON.stringify(d.key)}) { namespace key type value }`).join(" ");
  const vf = defs.variant.map((d, i) => `v${i}: metafield(namespace: ${JSON.stringify(d.namespace)}, key: ${JSON.stringify(d.key)}) { namespace key type value }`).join(" ");
  const data = await shopifyGraphql<{ product: (Record<string, Mf | null> & { variants: { nodes: (Record<string, Mf | null> & { id: string })[] } }) | null }>(domain, storeCode,
    `query($id: ID!) { product(id: $id) { ${pf} variants(first: 100) { nodes { id ${vf} } } } }`, { id: productGid });
  const vals = (o: Record<string, unknown> | undefined, prefix: string) => Object.entries(o ?? {}).filter(([k, v]) => k.startsWith(prefix) && /^\w\d+$/.test(k) && v).map(([, v]) => v as Mf);
  return {
    product: vals(data.product ?? undefined, "p"),
    variants: new Map((data.product?.variants.nodes ?? []).map((v) => [v.id, vals(v, "v")])),
  };
}

/** Wszystkie kolekcje sklepu (kategorie) – po 250. */
export async function listCollections(domain: string, storeCode: string) {
  type N = { id: string; title: string; handle: string };
  const out: N[] = [];
  let after: string | null = null;
  for (let page = 0; page < 40; page++) {
    const data: { collections: { nodes: N[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await shopifyGraphql(domain, storeCode,
      `query($after: String) { collections(first: 250, after: $after) { nodes { id title handle } pageInfo { hasNextPage endCursor } } }`, { after });
    out.push(...data.collections.nodes);
    if (!data.collections.pageInfo.hasNextPage) break;
    after = data.collections.pageInfo.endCursor;
  }
  return out;
}

/** Jedna strona (250) produktów kolekcji – same identyfikatory. `null` = kolekcji już nie ma. */
export async function collectionProductPage(domain: string, storeCode: string, collectionGid: string, after: string | null) {
  const data = await shopifyGraphql<{ collection: { products: { nodes: { id: string }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } | null }>(domain, storeCode,
    `query($id: ID!, $after: String) { collection(id: $id) { products(first: 250, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } } }`, { id: collectionGid, after });
  return data.collection?.products ?? null;
}

/** Kolekcja po adresie (handle), np. „nowosci-buty”. */
export async function collectionByHandle(domain: string, storeCode: string, handle: string) {
  const data = await shopifyGraphql<{ collectionByIdentifier: { id: string; title: string } | null }>(domain, storeCode,
    `query($h: String!) { collectionByIdentifier(identifier: { handle: $h }) { id title } }`, { h: handle });
  return data.collectionByIdentifier;
}

/** Które z podanych produktów są teraz w kolekcji (na żywo, po 100 na zapytanie). */
export async function productsInCollection(domain: string, storeCode: string, collectionGid: string, productGids: string[]) {
  const inside = new Set<string>();
  for (let i = 0; i < productGids.length; i += 100) {
    const data = await shopifyGraphql<{ nodes: ({ id: string; inCollection: boolean } | null)[] }>(domain, storeCode,
      `query($ids: [ID!]!, $c: ID!) { nodes(ids: $ids) { ... on Product { id inCollection(id: $c) } } }`, { ids: productGids.slice(i, i + 100), c: collectionGid });
    for (const n of data.nodes) if (n?.inCollection) inside.add(n.id);
  }
  return inside;
}
