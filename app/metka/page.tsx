import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isReused } from "@/lib/price-tag";

export const metadata = { title: "Metki sklepowe" };
export const dynamic = "force-dynamic";

/**
 * Druk metek: od razu PDF 57 × 32 mm. Gdy wśród zaznaczonych są rzeczy nowe i używane (dwa kolory naklejek),
 * najpierw wybór, którą rolkę drukujesz.
 */
export default async function PriceTagPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const raw = Array.isArray(sp.ids) ? sp.ids : (sp.ids ?? "").split(",");
  const ids = raw.flatMap((x) => x.split(",")).map((x) => x.trim()).filter((x) => /^[0-9a-f-]{36}$/.test(x)).slice(0, 200);
  const { supabase } = await requireProfile();
  if (!ids.length) return <p className="p-6 text-sm text-muted">Nie wybrano żadnych sztuk. W Magazynie zaznacz sztuki i kliknij „Wydrukuj metki”.</p>;
  const db = createAdminClient();
  void supabase;
  const { data } = await db.from("units").select("id, variant:variants(product_id), location:locations(store_id)").in("id", ids);
  const pids = [...new Set((data ?? []).map((u) => (u.variant as unknown as { product_id: string }).product_id))];
  const { data: links } = pids.length ? await db.from("product_store_links").select("product_id, store_id, tags").in("product_id", pids) : { data: [] };
  const used = (data ?? []).filter((u) => {
    const pid = (u.variant as unknown as { product_id: string }).product_id;
    return isReused((links ?? []).filter((l) => l.product_id === pid) as { store_id: string; tags: string[] | null }[], (u.location as unknown as { store_id: string }).store_id);
  }).length;
  const qs = ids.map((id) => `ids=${id}`).join("&");
  if (!used || used === ids.length) redirect(`/api/metka?${qs}`);
  return (
    <main className="mx-auto max-w-lg space-y-4 p-6">
      <h1 className="text-xl font-semibold">Metki: nowe i używane</h1>
      <p className="text-sm text-muted">Zaznaczone rzeczy są nowe ({ids.length - used}) i używane ({used} – tag „reused” w Shopify). Drukujesz je na naklejkach w innych kolorach – wybierz rolkę.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <a className="btn py-4 text-base" href={`/api/metka?${qs}&stan=nowe`} target="_blank" rel="noreferrer">Drukuj nowe ({ids.length - used})</a>
        <a className="btn py-4 text-base" href={`/api/metka?${qs}&stan=uzywane`} target="_blank" rel="noreferrer">Drukuj używane ({used})</a>
      </div>
    </main>
  );
}
