"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { accountServices, createPackage, deletePackage, furgonetkaConnection, getPackage, orderPackages, type Address, type NewPackage } from "@/lib/integrations/furgonetka";
import { fulfillWithTracking, getOrder } from "@/lib/integrations/shopify";
import { getSender, LOCKER_SIZES, SERVICE_LABEL, type ServiceKey } from "@/lib/orders/sender";
import { refreshOrderStatus, saveShopifyOrders, syncFurgonetkaShipments } from "@/lib/sync/shop-orders";
import { errorMessage } from "@/lib/errors";

export type LabelState = { error?: string; ok?: string; warning?: string; shipmentId?: string; tracking?: string } | null;

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const num = (fd: FormData, k: string) => {
  const v = Number(str(fd, k).replace(",", "."));
  return Number.isFinite(v) ? v : 0;
};

function normalizePhone(p: string) {
  const digits = p.replace(/[^\d+]/g, "");
  return digits.startsWith("00") ? `+${digits.slice(2)}` : digits;
}

function normalizePostcode(code: string, country: string) {
  const c = code.replace(/\s/g, "");
  return country === "PL" && /^\d{5}$/.test(c) ? `${c.slice(0, 2)}-${c.slice(2)}` : code.trim();
}

/** Etykieta z poziomu zamówienia: przesyłka w Furgonetce (InPost / DPD), nadanie, numer do Shopify. */
export async function createLabel(_: LabelState, fd: FormData): Promise<LabelState> {
  const { profile } = await requireProfile();
  const db = createAdminClient();
  const orderId = str(fd, "order_id");
  const { data: order } = await db.from("orders").select("*, store:stores(code, shopify_domain)").eq("id", orderId).maybeSingle();
  if (!order) return { error: "Nie ma takiego zamówienia." };
  if (order.cancelled_at) return { error: "Zamówienie jest anulowane." };
  if (!(await furgonetkaConnection(db))) return { error: "Aplikacja nie jest połączona z Furgonetką (Ustawienia → Wysyłka)." };

  const service = str(fd, "service") as ServiceKey;
  if (!(service in SERVICE_LABEL)) return { error: "Wybierz przewoźnika." };
  const carrier = service === "dpd" ? "dpd" : "inpost";
  const locker = service === "inpost_locker";

  const country = (str(fd, "country_code") || "PL").toUpperCase();
  const receiver: Address = {
    name: str(fd, "name"),
    company: str(fd, "company") || null,
    street: str(fd, "street"),
    postcode: normalizePostcode(str(fd, "postcode"), country),
    city: str(fd, "city"),
    country_code: country,
    email: str(fd, "email") || null,
    phone: normalizePhone(str(fd, "phone")) || null,
  };
  const point = str(fd, "point").toUpperCase();
  if (!receiver.name) return { error: "Podaj odbiorcę." };
  if (!receiver.phone) return { error: "Podaj telefon odbiorcy." };
  if (locker) {
    if (!point) return { error: "Podaj kod paczkomatu (np. WAW253M)." };
    if (!receiver.email) return { error: "Do paczkomatu potrzebny jest e-mail odbiorcy." };
    receiver.point = point;
  } else if (!receiver.street || !receiver.postcode || !receiver.city) {
    return { error: "Podaj pełny adres odbiorcy." };
  }

  const weight = num(fd, "weight") || 1;
  const size = str(fd, "size") as keyof typeof LOCKER_SIZES;
  const dims = locker
    ? LOCKER_SIZES[size] ?? LOCKER_SIZES.B
    : { width: num(fd, "width") || 25, depth: num(fd, "depth") || 35, height: num(fd, "height") || 15 };
  const value = num(fd, "value");
  const cod = num(fd, "cod");
  if (cod < 0 || value < 0) return { error: "Kwoty nie mogą być ujemne." };

  const sender = await getSender(db);
  const pickup: Address = {
    name: sender.name || null,
    company: sender.company || null,
    street: sender.street,
    postcode: sender.postcode,
    city: sender.city,
    country_code: "PL",
    email: sender.email || null,
    phone: normalizePhone(sender.phone) || null,
  };

  let services;
  try {
    services = await accountServices(db);
  } catch (e) {
    return { error: errorMessage(e) };
  }
  const svc = services.find((s) => s.service === carrier);
  if (!svc) return { error: `Na koncie Furgonetki nie ma usługi ${carrier.toUpperCase()}.` };

  const body: NewPackage = {
    pickup: carrier === "inpost" ? { ...pickup, point: sender.inpost_send_point || "any_apm" } : pickup,
    sender: pickup,
    receiver,
    service_id: svc.id,
    type: "package",
    user_reference_number: order.name,
    parcels: [{ width: dims.width, depth: dims.depth, height: dims.height, weight, ...(value > 0 ? { value } : {}), description: str(fd, "description") || undefined }],
    additional_services: cod > 0
      ? { cod: { amount: cod, express: false, ...(sender.cod_iban ? { iban: sender.cod_iban.replace(/\s/g, ""), name: sender.company } : {}) } }
      : {},
  };

  let packageId: string;
  try {
    const pkg = await createPackage(db, body);
    packageId = String(pkg.package_id);
  } catch (e) {
    return { error: errorMessage(e) };
  }
  const { data: ship, error: insErr } = await db.from("shipments").insert({
    order_id: order.id, provider: "furgonetka", external_id: packageId, service: carrier, reference: order.name,
    created_in_app: true, created_by: profile.id, state: "waiting",
  }).select("id").single();
  if (insErr) return { error: insErr.message };

  try {
    await orderPackages(db, [packageId]);
  } catch (e) {
    await deletePackage(db, packageId).catch(() => {});
    await db.from("shipments").delete().eq("id", ship.id);
    return { error: errorMessage(e) };
  }

  let tracking: string | null = null;
  let trackingUrl: string | null = null;
  try {
    const full = await getPackage(db, packageId);
    const parcel = full.parcels?.[0];
    tracking = parcel?.package_no ?? null;
    trackingUrl = parcel?.tracking_url ?? null;
    await db.from("shipments").update({
      tracking_number: tracking, tracking_url: trackingUrl, state: parcel?.state ?? full.state ?? "ordered",
      state_description: parcel?.state_description ?? null, state_at: parcel?.datetime_status ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", ship.id);
  } catch {
    // numer dojdzie przy następnym odczycie przesyłek
  }

  let warning: string | undefined;
  const store = order.store as { code: string; shopify_domain: string | null } | null;
  if (fd.get("fulfill") && tracking && store?.shopify_domain) {
    try {
      const note = await fulfillWithTracking(store.shopify_domain, store.code, order.shopify_order_id, {
        number: tracking, url: trackingUrl, company: carrier === "dpd" ? "DPD" : "InPost",
      }, !!fd.get("notify"));
      if (note) warning = `Shopify: ${note}.`;
      const fresh = await getOrder(store.shopify_domain, store.code, order.shopify_order_id);
      if (fresh) await saveShopifyOrders(db, order.store_id, [fresh]);
    } catch (e) {
      warning = `Etykieta jest, ale Shopify nie przyjął numeru: ${errorMessage(e)}`;
    }
  }
  await refreshOrderStatus(db, [order.id]);
  revalidatePath(`/sprzedaz/${order.id}`);
  revalidatePath("/sprzedaz");
  return { ok: "Etykieta utworzona.", shipmentId: ship.id, tracking: tracking ?? undefined, warning };
}

/** Odświeżenie jednego zamówienia ze Shopify i stanów przesyłek. */
export async function refreshOrder(fd: FormData) {
  await requireProfile();
  const db = createAdminClient();
  const id = str(fd, "id");
  const { data: order } = await db.from("orders").select("id, store_id, shopify_order_id, store:stores(code, shopify_domain)").eq("id", id).maybeSingle();
  if (!order) return;
  const store = order.store as unknown as { code: string; shopify_domain: string | null } | null;
  if (store?.shopify_domain) {
    const fresh = await getOrder(store.shopify_domain, store.code, order.shopify_order_id);
    if (fresh) await saveShopifyOrders(db, order.store_id, [fresh]);
  }
  if (await furgonetkaConnection(db)) await syncFurgonetkaShipments(db, 1).catch(() => null);
  await db.rpc("link_sales_to_orders");
  await refreshOrderStatus(db, [id]);
  revalidatePath(`/sprzedaz/${id}`);
}
