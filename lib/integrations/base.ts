import "server-only";

const BASE_URL = "https://api.baselinker.com/connector.php";

export class BaseApiError extends Error {
  constructor(public code: string, message: string) {
    super(`Base: ${message} (${code})`);
  }
}

type Json = Record<string, unknown>;

/** Wywołanie metody API Base. Limit Base: 100 zapytań na minutę. */
export async function baseCall<T = Json>(method: string, parameters: Json = {}): Promise<T> {
  const token = process.env.BASE_API_TOKEN;
  if (!token) throw new BaseApiError("NO_TOKEN", "brak BASE_API_TOKEN w ustawieniach serwera");
  const body = new URLSearchParams({ method, parameters: JSON.stringify(parameters) });
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(BASE_URL, {
      method: "POST",
      headers: { "X-BLToken": token, "Content-Type": "application/x-www-form-urlencoded" },
      body,
      cache: "no-store",
    });
    const data = (await res.json()) as Json;
    if (data.status === "SUCCESS") return data as T;
    const code = String(data.error_code ?? res.status);
    // Przekroczony limit zapytań – krótka pauza i ponowienie.
    if (code === "ERROR_BLOCKED_TOKEN" || code === "ERROR_TOO_MANY_REQUESTS" || res.status === 429) {
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
      continue;
    }
    throw new BaseApiError(code, String(data.error_message ?? "nieznany błąd"));
  }
  throw new BaseApiError("RATE_LIMIT", "przekroczony limit zapytań, spróbuj za minutę");
}

export type BaseProductData = {
  parent_id?: number;
  sku?: string;
  ean?: string;
  text_fields?: { name?: string };
  stock?: Record<string, number>;
  links?: Record<string, { product_id: string; variant_id: string }>;
  variants?: Record<string, { name?: string; sku?: string; ean?: string; stock?: Record<string, number> }>;
};

export async function getInventories() {
  const r = await baseCall<{ inventories: { inventory_id: number; name: string; is_default: boolean }[] }>("getInventories");
  return r.inventories;
}

export async function getInventoryWarehouses() {
  const r = await baseCall<{ warehouses: { warehouse_type: string; warehouse_id: number; name: string }[] }>("getInventoryWarehouses");
  return r.warehouses.map((w) => ({ id: `${w.warehouse_type}_${w.warehouse_id}`, name: w.name }));
}

export async function getOrderSources() {
  const r = await baseCall<{ sources: Record<string, Record<string, string>> }>("getOrderSources");
  return r.sources;
}

/** Wszystkie ID produktów głównych katalogu (po 1000 na stronę). */
export async function listInventoryProductIds(inventoryId: number) {
  const ids: number[] = [];
  for (let page = 1; page < 500; page++) {
    const r = await baseCall<{ products: Record<string, { id: number }> }>("getInventoryProductsList", {
      inventory_id: inventoryId,
      page,
    });
    const batch = Object.keys(r.products ?? {}).map(Number);
    ids.push(...batch);
    if (batch.length < 1000) break;
  }
  return ids;
}

export async function getInventoryProductsData(inventoryId: number, productIds: number[]) {
  const out: Record<string, BaseProductData> = {};
  for (let i = 0; i < productIds.length; i += 100) {
    const r = await baseCall<{ products: Record<string, BaseProductData> }>("getInventoryProductsData", {
      inventory_id: inventoryId,
      products: productIds.slice(i, i + 100),
    });
    Object.assign(out, r.products ?? {});
  }
  return out;
}

/** Aktualny stan jednego produktu lub wariantu w danym magazynie Base. */
export async function getStock(inventoryId: number, baseProductId: number, baseParentId: number | null, warehouseId: string) {
  const lookupId = baseParentId && baseParentId > 0 ? baseParentId : baseProductId;
  const data = await getInventoryProductsData(inventoryId, [lookupId]);
  const product = data[String(lookupId)];
  if (!product) throw new BaseApiError("NOT_FOUND", `nie ma produktu ${lookupId} w katalogu ${inventoryId}`);
  const stock = baseParentId && baseParentId > 0 ? product.variants?.[String(baseProductId)]?.stock : product.stock;
  if (!stock) throw new BaseApiError("NOT_FOUND", `nie ma wariantu ${baseProductId} w produkcie ${lookupId}`);
  return Number(stock[warehouseId] ?? 0);
}

export async function setStock(inventoryId: number, stocks: Record<string, Record<string, number>>) {
  const r = await baseCall<{ counter: number; warnings?: Record<string, string> }>("updateInventoryProductsStock", {
    inventory_id: inventoryId,
    products: stocks,
  });
  const warnings = r.warnings && Object.keys(r.warnings).length ? r.warnings : null;
  if (warnings) throw new BaseApiError("WARNING", Object.entries(warnings).map(([k, v]) => `${k}: ${v}`).join("; "));
  return r.counter;
}

export type BaseOrder = {
  order_id: number;
  shop_order_id?: number;
  external_order_id?: string;
  order_source?: string;
  order_source_id?: number;
  date_confirmed?: number;
  date_add?: number;
  products: {
    storage?: string;
    storage_id?: number;
    order_product_id: number;
    product_id?: string;
    variant_id?: string;
    name?: string;
    sku?: string;
    ean?: string;
    quantity: number;
    price_brutto?: number;
  }[];
};

export async function getOrdersConfirmedFrom(fromUnix: number) {
  const r = await baseCall<{ orders: BaseOrder[] }>("getOrders", { date_confirmed_from: fromUnix });
  return r.orders ?? [];
}

/** Wystawia paragon do zamówienia w Base; drukuje go drukarka fiskalna podpięta do Base. */
export async function addReceipt(orderId: number, seriesId?: number) {
  const r = await baseCall<{ receipt_id: number }>("addReceipt", { order_id: orderId, ...(seriesId ? { series_id: seriesId } : {}) });
  return r.receipt_id;
}

export type BaseReceipt = {
  receipt_id: number;
  series_id?: number;
  receipt_full_nr?: string;
  receipt_nr?: string | number;
  order_id: number;
  date_add: number;
  currency?: string;
  products?: { name: string; price_brutto: number; tax_rate: number; quantity: number; sku?: string }[];
};

/** Paragony wystawione w Base (po 100), od podanego ID albo daty. */
export async function getReceipts(opts: { idFrom?: number; dateFrom?: number }) {
  const r = await baseCall<{ receipts?: BaseReceipt[] }>("getReceipts", {
    ...(opts.idFrom ? { id_from: opts.idFrom } : {}),
    ...(opts.dateFrom ? { date_from: opts.dateFrom } : {}),
  });
  return r.receipts ?? [];
}
