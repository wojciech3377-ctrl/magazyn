import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { shopifyGraphql } from "@/lib/integrations/shopify";

/**
 * „Dlaczego ta sztuka jest w magazynie, a w Shopify / na stronie stan 0?” – stan rozmiaru w Shopify na żywo
 * (po lokalizacjach) obok sztuk w aplikacji i lista przyczyn według zasad automatu stanów.
 */
export type UnitStockLevel = { location: string; mapped: boolean; mine: boolean; online: boolean; available: number; committed: number; app: number | null };
export type UnitStockDiag = {
  levels: UnitStockLevel[];
  reasons: { tone: "ok" | "warn" | "bad"; text: string }[];
  product: { status: string; url: string | null } | null;
  canAlign: boolean;
  error: string | null;
};

const when = (d: string) => new Date(d).toLocaleString("pl-PL", { timeZone: "Europe/Warsaw", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

type Live = {
  productVariant: { product: { status: string; onlineStoreUrl: string | null } } | null;
  inventoryItem: { tracked: boolean; inventoryLevels: { nodes: { location: { id: string; name: string; fulfillsOnlineOrders: boolean; isActive: boolean }; quantities: { name: string; quantity: number }[] }[] } } | null;
};

export async function diagnoseUnitStock(db: SupabaseClient, unitId: string): Promise<UnitStockDiag> {
  const out: UnitStockDiag = { levels: [], reasons: [], product: null, canAlign: false, error: null };
  const say = (tone: "ok" | "warn" | "bad", text: string) => out.reasons.push({ tone, text });
  const { data: u } = await db.from("units").select("id, code, status, owner_type, variant_id, location:locations(id, name, store_id, shopify_location_id, store:stores(id, name, code, shopify_domain))").eq("id", unitId).maybeSingle();
  if (!u) return { ...out, error: "Nie ma takiej sztuki." };
  const loc = u.location as unknown as { id: string; name: string; store_id: string; shopify_location_id: string | null; store: { id: string; name: string; code: string; shopify_domain: string | null } };
  const store = loc.store;

  if (u.status === "reserved") {
    const { data: sale } = await db.from("sales").select("order_ref").eq("unit_id", unitId).neq("status", "cancelled").limit(1).maybeSingle();
    say("ok", `Sztuka jest zarezerwowana pod zamówienie${sale?.order_ref ? ` ${sale.order_ref}` : ""}. Shopify odjął ją przy zamówieniu, więc na stronie 0 jest poprawne. Po paragonie lub fakturze stanie się sprzedana.`);
  } else if (u.status === "in_transit") say("ok", "Sztuka jest „w drodze” – nie liczy się do stanu w Shopify, dopóki jej nie przyjmiesz.");
  else if (u.status !== "in_stock") say("ok", "Ta sztuka nie jest „na stanie”, więc nie liczy się do stanu w Shopify.");

  if (!store.shopify_domain) { say("bad", `Sklep ${store.name} nie ma połączenia ze Shopify.`); return out; }
  if (!loc.shopify_location_id) say("bad", `Lokalizacja „${loc.name}” nie ma przypisanej lokalizacji Shopify – automat stanów jej nie porównuje, więc sztuki tu zostają. Ustawienia → Sklepy i lokalizacje.`);

  const [{ data: links }, { data: locs }, { data: recent }, { data: excess }, { data: auto }] = await Promise.all([
    db.from("variant_store_links").select("shopify_variant_id, shopify_inventory_item_id, inventory_tracked").eq("variant_id", u.variant_id).eq("store_id", store.id),
    db.from("locations").select("id, name, shopify_location_id").eq("store_id", store.id).eq("active", true),
    db.from("unit_events").select("created_at, unit:units!inner(variant_id)").eq("unit.variant_id", u.variant_id).gte("created_at", new Date(Date.now() - 30 * 60_000).toISOString()).order("created_at", { ascending: false }).limit(1),
    db.from("stock_excess").select("missing, first_seen_at, location_id").eq("variant_id", u.variant_id),
    db.from("sync_state").select("value").eq("key", "auto_catalog").maybeSingle(),
  ]);
  const link = (links ?? [])[0] as { shopify_variant_id: string | null; shopify_inventory_item_id: string | null; inventory_tracked: boolean | null } | undefined;
  if (!link?.shopify_variant_id) {
    say("bad", `Ten rozmiar nie jest powiązany z żadnym wariantem w Shopify (${store.name}) – zwykle produkt albo rozmiar został usunięty w Shopify. Automat stanów go nie porównuje; sztuki z umową, dostawą, sprzedażą albo komisowe zostają ze znacznikiem „brak w Shopify”. Usuń sztukę albo użyj „Wydaj poza sklepem”.`);
    return out;
  }
  if ((links ?? []).length > 1) say("warn", `Ten rozmiar jest połączony z ${(links ?? []).length} wariantami Shopify o tym samym SKU – liczony jest większy stan. Ustawienia → Stany → „Sprawdź produkt” rozdzieli je.`);
  if (link.inventory_tracked === false) say("bad", "W Shopify ten rozmiar nie śledzi stanu („sprzedawaj zawsze” / bez śledzenia) – automat go nie liczy.");

  // Lokalizacje aplikacji przypisane do tej samej lokalizacji Shopify liczą się razem.
  const sameShopLoc = (sid: string | null) => (locs ?? []).filter((l) => sid && String(l.shopify_location_id).split("/").pop() === sid.split("/").pop()).map((l) => l.id as string);
  const { data: units } = await db.from("units").select("location_id, status").eq("variant_id", u.variant_id).in("status", ["in_stock", "reserved"]);

  let live: Live;
  try {
    live = await shopifyGraphql<Live>(store.shopify_domain, store.code,
      `query($v: ID!, $i: ID!) { productVariant(id: $v) { product { status onlineStoreUrl } } inventoryItem(id: $i) { tracked inventoryLevels(first: 50) { nodes { location { id name fulfillsOnlineOrders isActive } quantities(names: ["available", "committed"]) { name quantity } } } } }`,
      { v: link.shopify_variant_id, i: link.shopify_inventory_item_id ?? "gid://shopify/InventoryItem/0" });
  } catch (e) {
    return { ...out, error: `Shopify: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!live.productVariant) { say("bad", "Tego wariantu nie ma już w Shopify – produkt albo rozmiar usunięto. Przy kolejnym odczycie katalogu dostanie znacznik „brak w Shopify”."); return out; }
  out.product = { status: live.productVariant.product.status, url: live.productVariant.product.onlineStoreUrl };
  const q = (n: { quantities: { name: string; quantity: number }[] }, k: string) => n.quantities.find((x) => x.name === k)?.quantity ?? 0;
  const mineShop = loc.shopify_location_id ? loc.shopify_location_id.split("/").pop() : null;
  for (const n of live.inventoryItem?.inventoryLevels.nodes ?? []) {
    const ids = sameShopLoc(n.location.id);
    out.levels.push({
      location: n.location.name, mapped: ids.length > 0, mine: n.location.id.split("/").pop() === mineShop, online: n.location.fulfillsOnlineOrders && n.location.isActive,
      available: q(n, "available"), committed: q(n, "committed"),
      app: ids.length ? (units ?? []).filter((x) => x.status === "in_stock" && ids.includes(x.location_id as string)).length : null,
    });
  }
  const mine = out.levels.find((l) => l.mine);
  if (loc.shopify_location_id && !mine) say("bad", `W Shopify ten rozmiar nie jest dostępny w lokalizacji przypisanej do „${loc.name}” (brak stanu w tej lokalizacji) – automat nie ma czego porównać, więc sztuka zostaje. Aktywuj rozmiar w tej lokalizacji w Shopify albo przenieś sztukę.`);

  if (mine && u.status === "in_stock") {
    const app = mine.app ?? 0;
    const shop = Math.max(0, mine.available);
    if (app > shop) {
      const last = recent?.[0]?.created_at as string | undefined;
      const ex = (excess ?? []).find((e) => sameShopLoc(loc.shopify_location_id).includes(e.location_id as string));
      say("warn", `W Shopify (${mine.location}) dostępne: ${shop}, w aplikacji na stanie: ${app}.`);
      if (u.owner_type === "consignment") say("bad", "To sztuka komisowa – automat stanów nigdy nie usuwa komisu. Oddaj ją komisantowi („Wysyłka do komisanta”) albo popraw stan w Shopify.");
      else if (last) say("warn", `Ten rozmiar miał ruch w aplikacji o ${when(last)} – automat czeka 30 minut od ostatniej zmiany, żeby nie walczyć z pracą w sklepie.`);
      else if (ex && Date.now() - Date.parse(ex.first_seen_at as string) < 30 * 60_000) say("warn", `Różnica czeka na potwierdzenie od ${when(ex.first_seen_at as string)} – nadmiar znika po 30 minutach.`);
      else {
        const at = (auto?.value as { at?: string } | null)?.at;
        say("warn", `Automat powinien to wyrównać przy kolejnym porównaniu stanów (co ok. 20 min${at ? `, ostatnie: ${when(at)}` : ""}). Nadmiar zdejmowany jest od najnowszych sztuk; własne sztuki z historią są wycofywane po 50 naraz.`);
      }
      out.canAlign = u.owner_type !== "consignment";
    } else if (shop > 0) {
      const p = live.productVariant.product;
      if (p.status !== "ACTIVE") say("warn", `W Shopify produkt ma status ${p.status === "DRAFT" ? "wersja robocza" : p.status === "ARCHIVED" ? "zarchiwizowany" : p.status} – na stronie sklepu go nie widać, choć stan to ${shop}.`);
      else if (!p.onlineStoreUrl) say("warn", `Produkt nie jest opublikowany w sklepie internetowym – stan w Shopify to ${shop}, ale strona go nie pokazuje.`);
      else if (!mine.online) say("warn", `Lokalizacja Shopify „${mine.location}” nie realizuje zamówień online – jej stan (${shop}) nie jest widoczny na stronie sklepu.`);
      else say("ok", `W Shopify (${mine.location}) ten rozmiar ma ${shop} dostępnych – strona powinna go pokazywać. Sprawdź, czy patrzysz na ten sam produkt i rozmiar (np. osobny produkt z tym samym SKU).`);
    } else if (app === shop) say("ok", "Stan w aplikacji zgadza się ze Shopify.");
  }
  if (mine && mine.committed > 0) say("ok", `W Shopify ${mine.committed} szt. tego rozmiaru jest zarezerwowane przez zamówienia.`);
  if (!out.reasons.length) say("ok", "Nie widać różnicy między aplikacją a Shopify.");
  return out;
}

/** Wyrównanie jednego rozmiaru do Shopify teraz (bez czekania 10 / 30 min; komisu nie rusza, ruch z ostatnich 30 min nadal blokuje). */
export async function alignUnitVariant(db: SupabaseClient, unitId: string) {
  const { data: u } = await db.from("units").select("variant_id, location:locations(store_id, store:stores(id, name, code, shopify_domain))").eq("id", unitId).maybeSingle();
  if (!u) throw new Error("Nie ma takiej sztuki.");
  const store = (u.location as unknown as { store: { id: string; name: string; code: string; shopify_domain: string | null } }).store;
  if (!store.shopify_domain) throw new Error("Sklep bez połączenia ze Shopify.");
  const [{ data: link }, { data: locs }] = await Promise.all([
    db.from("variant_store_links").select("shopify_inventory_item_id").eq("variant_id", u.variant_id).eq("store_id", store.id).not("shopify_inventory_item_id", "is", null).limit(1).maybeSingle(),
    db.from("locations").select("id, shopify_location_id, created_at").eq("store_id", store.id).eq("active", true).not("shopify_location_id", "is", null).order("created_at"),
  ]);
  if (!link) throw new Error("Rozmiar nie jest powiązany ze Shopify.");
  const data = await shopifyGraphql<{ inventoryItem: { inventoryLevels: { nodes: { location: { id: string }; quantities: { quantity: number }[] }[] } } | null }>(store.shopify_domain, store.code,
    `query($i: ID!) { inventoryItem(id: $i) { inventoryLevels(first: 50) { nodes { location { id } quantities(names: ["available"]) { quantity } } } } }`, { i: link.shopify_inventory_item_id });
  const rows = (data.inventoryItem?.inventoryLevels.nodes ?? []).flatMap((n) => {
    const group = (locs ?? []).filter((l) => String(l.shopify_location_id).split("/").pop() === n.location.id.split("/").pop()).map((l) => l.id as string);
    return group.length ? [{ variant_id: u.variant_id, location_id: group[0], qty: Math.max(0, n.quantities[0]?.quantity ?? 0), count_locations: group }] : [];
  });
  if (!rows.length) throw new Error("W Shopify nie ma stanu tego rozmiaru w żadnej przypisanej lokalizacji.");
  const { data: r, error } = await db.rpc("reconcile_stock", {
    p_rows: rows, p_limit: 1000, p_source: `Shopify ${store.name}`, p_scope: null,
    p_confirm_minutes: 0, p_remove: true, p_surplus_minutes: 0, p_history_limit: 1000,
  });
  if (error) throw new Error(error.message);
  return r as { created?: number; removed?: number; withdrawn?: number; kept?: number };
}
