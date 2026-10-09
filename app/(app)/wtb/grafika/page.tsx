import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { wtbPages } from "@/lib/wtb";

/** Podgląd grafik WTB (po maks. 16 par na grafikę) z przyciskami pobierania. */
export default async function WtbGrafikaPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const { supabase } = await requireProfile();
  const raw = sp.ids;
  const ids = (Array.isArray(raw) ? raw : raw ? raw.split(",") : []).filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 200);
  let query = supabase.from("wtb_items").select("id");
  query = ids.length ? query.in("id", ids) : query.eq("status", "active");
  const { data } = await query.order("created_at");
  const found = new Set((data ?? []).map((d) => d.id as string));
  const ordered = ids.length ? ids.filter((id) => found.has(id)) : [...found];
  const pages = wtbPages(ordered);
  const idsParam = ids.length ? `ids=${ordered.join(",")}&` : "";

  return (
    <>
      <PageHeader
        title="Grafika WTB"
        sub={`${ordered.length} ${ordered.length === 1 ? "para" : "par"} · ${pages.length} ${pages.length === 1 ? "grafika" : "grafiki"} 1080 × 1350`}
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
                <a className="btn" href={`/api/wtb?${idsParam}strona=${i + 1}&pobierz=1`}>Pobierz PNG</a>
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </>
  );
}
