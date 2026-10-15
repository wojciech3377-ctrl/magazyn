import type { SupabaseClient } from "@supabase/supabase-js";

/** Co zmieniło się w katalogu i magazynie od chwili `since` (podgląd po „Sprawdź nowe produkty i stany”). */
export type Changes = {
  since: string;
  newProducts: { id: string; title: string }[];
  updatedProducts: { id: string; title: string }[];
  newUnits: { id: string; code: string; title: string; option: string; place: string; status: string }[];
  unitEvents: { id: string; code: string; title: string; option: string; type: string; from: string | null; to: string | null }[];
  more: { newProducts: number; updatedProducts: number; newUnits: number; unitEvents: number };
};

const LIMIT = 100;

export async function changesSince(db: SupabaseClient, since: string): Promise<Changes> {
  const [created, updated, units, events] = await Promise.all([
    db.from("products").select("id, title", { count: "exact" }).gte("created_at", since).order("title").limit(LIMIT),
    db.from("products").select("id, title", { count: "exact" }).gte("updated_at", since).lt("created_at", since).order("title").limit(LIMIT),
    db.from("units").select("id, code, status, location:locations(name), variant:variants(option, product:products(title))", { count: "exact" }).gte("created_at", since).order("number").limit(LIMIT),
    db.from("unit_events").select("id, type, data, unit:units(code, variant:variants(option, product:products(title)))", { count: "exact" }).gte("created_at", since).order("created_at").limit(LIMIT),
  ]);
  type V = { option: string; product: { title: string } | null } | null;
  const str = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? null : String(v));
  return {
    since,
    newProducts: (created.data ?? []).map((p) => ({ id: p.id as string, title: p.title as string })),
    updatedProducts: (updated.data ?? []).map((p) => ({ id: p.id as string, title: p.title as string })),
    newUnits: (units.data ?? []).map((u) => {
      const v = u.variant as unknown as V;
      return { id: u.id as string, code: u.code as string, title: v?.product?.title ?? "?", option: v?.option ?? "", place: (u.location as unknown as { name: string } | null)?.name ?? "", status: u.status as string };
    }),
    unitEvents: (events.data ?? []).map((e) => {
      const u = e.unit as unknown as { code: string; variant: V } | null;
      const d = (e.data ?? {}) as Record<string, unknown>;
      return { id: e.id as string, code: u?.code ?? "?", title: u?.variant?.product?.title ?? "?", option: u?.variant?.option ?? "", type: e.type as string, from: str(d.from), to: str(d.to ?? d.status) };
    }),
    more: {
      newProducts: Math.max(0, (created.count ?? 0) - LIMIT),
      updatedProducts: Math.max(0, (updated.count ?? 0) - LIMIT),
      newUnits: Math.max(0, (units.count ?? 0) - LIMIT),
      unitEvents: Math.max(0, (events.count ?? 0) - LIMIT),
    },
  };
}
