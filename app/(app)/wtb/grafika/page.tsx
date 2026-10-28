import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { wtbPages } from "@/lib/wtb";
import { groupWtb } from "@/lib/wtb-group";
import { DownloadPng } from "./DownloadPng";

/** Podgląd grafik WTB (po maks. 30 modeli na grafikę) z przyciskami pobierania. */
export default async function WtbGrafikaPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const { supabase } = await requireProfile();
  const raw = sp.ids;
  const ids = (Array.isArray(raw) ? raw : raw ? raw.split(",") : []).filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 200);
  let query = supabase.from("wtb_items").select("*");
  query = ids.length ? query.in("id", ids) : query.eq("status", "active");
  const { data } = await query.order("created_at");
  const found = new Set((data ?? []).map((d) => d.id as string));
  const ordered = ids.length ? ids.filter((id) => found.has(id)) : [...found];
  const groups = groupWtb(ordered.map((id) => data!.find((d) => d.id === id)!));
  const pages = wtbPages(groups);
  const idsParam = ids.length ? `ids=${ordered.join(",")}&` : "";

  return (
    <>
      <PageHeader
        title="Grafika WTB"
        sub={`${groups.length} ${groups.length === 1 ? "model" : "modeli"} (${ordered.length} ${ordered.length === 1 ? "rozmiar" : "rozmiarów"}) · ${pages.length} ${pages.length === 1 ? "grafika" : "grafiki"} 1080 × 1350`}
        actions={<Link className="btn-secondary" href="/wtb">Wróć do listy</Link>}
      />
      {!pages.length ? <p className="text-muted">Nic nie zaznaczono.</p> : (
        <div className="grid gap-6 md:grid-cols-2">
          {pages.map((_, i) => (
            <figure key={i} className="space-y-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/wtb?${idsParam}strona=${i + 1}`} alt={`Grafika WTB ${i + 1}`} className="w-full rounded-lg border border-line" />
              <figcaption className="flex items-center justify-between">
                <span className="text-sm text-muted">{pages.length > 1 ? `Grafika ${i + 1} z ${pages.length}` : "Grafika"}</span>
                <DownloadPng src={`/api/wtb?${idsParam}strona=${i + 1}`} name={`wtb-${new Date().toISOString().slice(0, 10)}${pages.length > 1 ? `-${i + 1}` : ""}.png`} />
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </>
  );
}
