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
      inventoryItem: { id: string; tracked: boolean } | null;
    }[];
  };
};

const PRODUCT_FIELDS = `
  id title handle vendor productType status
  featuredMedia { preview { image { url } } }
  variants(first: 250) { nodes { id title sku barcode position price inventoryItem { id tracked } } }
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
) {
  const fo = await shopifyGraphql<{ order: { fulfillmentOrders: { nodes: { id: string; status: string }[] } } | null }>(
    domain,
    storeCode,
    `query($id: ID!) { order(id: $id) { fulfillmentOrders(first: 10) { nodes { id status } } } }`,
    { id: orderId },
  );
  const open = (fo.order?.fulfillmentOrders.nodes ?? []).filter((n) => n.status === "OPEN" || n.status === "IN_PROGRESS");
  if (!open.length) return "brak otwartych pozycji do wysłania w Shopify";
  const data = await shopifyGraphql<{ fulfillmentCreate: { fulfillment: { id: string } | null; userErrors: { message: string }[] } }>(
    domain,
    storeCode,
    `mutation($f: FulfillmentInput!) { fulfillmentCreate(fulfillment: $f) { fulfillment { id status } userErrors { field message } } }`,
    {
      f: {
        lineItemsByFulfillmentOrder: open.map((n) => ({ fulfillmentOrderId: n.id })),
        trackingInfo: { number: tracking.number, company: tracking.company, ...(tracking.url ? { url: tracking.url } : {}) },
        notifyCustomer,
      },
    },
  );
  const err = data.fulfillmentCreate.userErrors.map((e) => e.message).join("; ");
  if (err) throw new Error(`Shopify: ${err}`);
  return null;
}

export type CancelReason = "CUSTOMER" | "DECLINED" | "FRAUD" | "INVENTORY" | "OTHER" | "STAFF";

/**
 * Anulowanie zamówienia w Shopify (nieodwracalne). Stan magazynowy prowadzi Base, więc restock = false –
 * sztuki wracają na stan w aplikacji, a Base aktualizuje sklep. Wymaga uprawnienia write_orders.
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
