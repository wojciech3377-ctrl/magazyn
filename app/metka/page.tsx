import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isUsed } from "@/lib/price-tag";

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
  const { data } = await createAdminClient().from("units").select("id, variant:variants(option, product:products(title, style_sku))").in("id", ids);
  void supabase;
  const used = (data ?? []).filter((u) => {
    const v = u.variant as unknown as { option: string; product: { title: string; style_sku: string | null } };
    return isUsed(v.product.style_sku, v.product.title, v.option);
  }).length;
  const qs = ids.map((id) => `ids=${id}`).join("&");
  if (!used || used === ids.length) redirect(`/api/metka?${qs}`);
  return (
    <main className="mx-auto max-w-lg space-y-4 p-6">
      <h1 className="text-xl font-semibold">Metki: nowe i używane</h1>
      <p className="text-sm text-muted">Zaznaczone rzeczy są nowe ({ids.length - used}) i używane ({used}). Drukujesz je na naklejkach w innych kolorach – wybierz rolkę.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <a className="btn py-4 text-base" href={`/api/metka?${qs}&stan=nowe`} target="_blank" rel="noreferrer">Drukuj nowe ({ids.length - used})</a>
        <a className="btn py-4 text-base" href={`/api/metka?${qs}&stan=uzywane`} target="_blank" rel="noreferrer">Drukuj używane ({used})</a>
      </div>
    </main>
  );
}
