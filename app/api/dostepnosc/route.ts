import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { shopifyLocations } from "@/lib/sync/shopify-stock";
import { ipFrom, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";

/**
 * Publiczna dostępność dla karty produktu w sklepie internetowym: ile sztuk każdego rozmiaru leży w której lokalizacji.
 * GET /api/dostepnosc?sklep=<kod sklepu>&warianty=<id wariantu Shopify>,<id>…  (do 250 rozmiarów)
 * Odpowiedź: { "<id wariantu>": { "<nazwa lokalizacji Shopify>": ilość, … }, … }
 * Klucz to nazwa lokalizacji Shopify przypisanej do lokalizacji aplikacji (bez przypisania – nazwa w aplikacji).
 * Tylko liczby sztuk na stanie – bez cen, umów i danych osobowych.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Nazwy lokalizacji Shopify – rzadko się zmieniają, trzymamy 10 min w pamięci instancji.
const namesCache = new Map<string, { at: number; names: Map<string, string> }>();

async function locationNames(domain: string, code: string) {
  const hit = namesCache.get(domain);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.names;
  try {
    const names = new Map((await shopifyLocations(domain, code)).map((l) => [l.id, l.name]));
    namesCache.set(domain, { at: Date.now(), names });
    return names;
  } catch {
    // Błąd Shopify: pusta lista na 1 minutę (bez pytania Shopify przy każdym wejściu – limit API wspólny z synchronizacją).
    const names = hit?.names ?? new Map<string, string>();
    namesCache.set(domain, { at: Date.now() - 9 * 60_000, names });
    return names;
  }
}

const json = (body: unknown, status = 200, cache = "public, max-age=30, s-maxage=30, stale-while-revalidate=60") =>
  NextResponse.json(body, { status, headers: { ...CORS, "Cache-Control": cache } });

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(req: NextRequest) {
  // Publiczny adres – limit zapytań z jednego IP (zmiana parametrów omija pamięć podręczną CDN).
  if (!(await rateLimit(`dostepnosc:${ipFrom(req.headers)}`, 300, 300))) return json({ error: "za dużo zapytań" }, 429, "no-store");
  const code = (req.nextUrl.searchParams.get("sklep") ?? "").trim();
  const ids = [...new Set((req.nextUrl.searchParams.get("warianty") ?? "").split(",").map((x) => x.trim()).filter((x) => /^\d{1,20}$/.test(x)))].slice(0, 250);
  if (!/^[a-z0-9_-]{1,40}$/i.test(code) || !ids.length) return json({ error: "podaj sklep i warianty" }, 400, "no-store");

  const db = createAdminClient();
  const { data: store } = await db.from("stores").select("id, code, shopify_domain").eq("code", code).maybeSingle();
  if (!store) return json({ error: "nieznany sklep" }, 404, "no-store");

  const gids = ids.map((id) => `gid://shopify/ProductVariant/${id}`);
  const [{ data: links }, { data: locs }] = await Promise.all([
    db.from("variant_store_links").select("variant_id, shopify_variant_id").eq("store_id", store.id).in("shopify_variant_id", gids),
    db.from("locations").select("id, name, shopify_location_id").eq("store_id", store.id).eq("active", true),
  ]);
  const out: Record<string, Record<string, number>> = Object.fromEntries(ids.map((id) => [id, {}]));
  const byVariant = new Map<string, string[]>();
  for (const l of links ?? []) {
    const shopId = (l.shopify_variant_id as string).split("/").pop()!;
    byVariant.set(l.variant_id as string, [...(byVariant.get(l.variant_id as string) ?? []), shopId]);
  }
  if (!byVariant.size || !locs?.length) return json(out);

  let names = new Map<string, string>();
  if (store.shopify_domain) names = await locationNames(store.shopify_domain as string, store.code as string);
  const label = new Map(locs.map((l) => [l.id as string, (l.shopify_location_id && names.get(l.shopify_location_id as string)) || (l.name as string)]));

  // Każda lokalizacja (sklep / magazyn) pojawia się w odpowiedzi, także z zerem.
  for (const id of ids) for (const name of new Set(label.values())) out[id][name] = 0;

  const { data: units, error } = await db.from("units").select("variant_id, location_id")
    .eq("status", "in_stock").in("variant_id", [...byVariant.keys()]).in("location_id", [...label.keys()]).limit(10000);
  if (error) return json({ error: "błąd odczytu" }, 500, "no-store");
  for (const u of units ?? []) {
    const name = label.get(u.location_id as string);
    if (!name) continue;
    for (const shopId of byVariant.get(u.variant_id as string) ?? []) out[shopId][name] = (out[shopId][name] ?? 0) + 1;
  }
  return json(out);
}
