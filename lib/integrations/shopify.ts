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
      inventoryItem: { id: string; tracked: boolean } | null;
    }[];
  };
};

const PRODUCT_FIELDS = `
  id title handle vendor productType status
  featuredMedia { preview { image { url } } }
  variants(first: 250) { nodes { id title sku barcode position inventoryItem { id tracked } } }
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

export async function registerProductWebhooks(domain: string, storeCode: string, callbackUrl: string) {
  const results: string[] = [];
  for (const topic of ["PRODUCTS_CREATE", "PRODUCTS_UPDATE", "PRODUCTS_DELETE"]) {
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
    results.push(`${topic}: ${err || "ok"}`);
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
