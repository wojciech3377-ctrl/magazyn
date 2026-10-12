import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { dateOnly } from "@/lib/labels";
import { Notice, PageHeader } from "@/components/ui";
import { SelectAll } from "@/components/SelectAll";
import { WtbAdd } from "./WtbAdd";
import { editWtbItem, updateWtb } from "./actions";

const TABS = [
  { key: "", label: "Szukamy", status: "active" },
  { key: "kupione", label: "Kupione", status: "bought" },
] as const;

export default async function WtbPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { supabase } = await requireProfile();
  const tab = TABS.find((t) => t.key === (sp.widok ?? "")) ?? TABS[0];
  const [{ data: items }, ...counts] = await Promise.all([
    supabase.from("wtb_items").select("id, title, size, sku, image_url, note, source, order_id, created_at, closed_at").eq("status", tab.status)
      .order(tab.status === "active" ? "created_at" : "closed_at", { ascending: tab.status === "active" }).limit(500),
    ...TABS.map((t) => supabase.from("wtb_items").select("id", { count: "exact", head: true }).eq("status", t.status)),
  ]);
  const back = tab.key ? `/wtb?widok=${tab.key}` : "/wtb";
  const active = tab.status === "active";

  return (
    <>
      <PageHeader
        title="WTB – szukamy"
        sub="Buty, które chcemy odkupić. Zaznacz pozycje i zrób z nich grafikę „SNEAKERS DEPOT WTB” (do 16 par na jednej grafice, więcej = kilka grafik)."
        actions={active && items?.length ? <Link className="btn" href="/wtb/grafika">Grafika z całej listy ({items.length})</Link> : null}
      />
      {sp.ok && <div className="mb-4"><Notice tone="ok">{sp.ok}</Notice></div>}
      {sp.blad && <div className="mb-4"><Notice tone="error">{sp.blad}</Notice></div>}

      {active && (
        <div className="mb-5 grid gap-5 lg:grid-cols-[1fr_320px]">
          <WtbAdd />
          {!!items?.length && (
            <Link href="/wtb/grafika" className="group block rounded-lg border border-line bg-white p-2 transition hover:border-accent hover:shadow-md" title="Podgląd grafiki z całej listy">
              <span className="mb-1 block text-xs font-medium text-muted group-hover:text-accent">Podgląd grafiki z całej listy{items.length > 16 ? " (pierwsza z kilku)" : ""} →</span>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/wtb?strona=1&v=${items.length}-${items.map((i) => i.id.slice(0, 4)).join("").slice(0, 40)}`} alt="Podgląd grafiki WTB" className="w-full rounded" loading="lazy" />
            </Link>
          )}
        </div>
      )}

      <nav className="mb-4 flex gap-1 border-b border-line text-sm" aria-label="Lista WTB">
        {TABS.map((t, i) => (
          <Link key={t.key} href={t.key ? `/wtb?widok=${t.key}` : "/wtb"}
            className={`-mb-px border-b-2 px-3 py-2 ${tab.key === t.key ? "border-accent font-medium text-ink" : "border-transparent text-muted hover:text-ink"}`}>
            {t.label} <span className="ml-1 rounded bg-panel px-1.5 py-0.5 text-xs tabular-nums">{counts[i].count ?? 0}</span>
          </Link>
        ))}
      </nav>

      {!items?.length ? (
        <p className="py-10 text-center text-muted">{active ? "Lista jest pusta. Dodaj buty z katalogu albo przyciskiem „Dodaj do WTB” przy zamówieniu." : "Nic jeszcze nie kupiono z listy."}</p>
      ) : (
        <form action={updateWtb}>
          <input type="hidden" name="back" value={back} />
          <div className="sticky top-0 z-20 mb-3 flex flex-wrap items-center gap-2 border-b border-line bg-white/95 py-2 backdrop-blur">
            <label className="flex items-center gap-2 text-sm"><SelectAll /> zaznacz wszystkie</label>
            {active ? (
              <>
                <button className="btn" formAction="/wtb/grafika" formMethod="get">Grafika z zaznaczonych</button>
                <button className="btn-secondary" name="to" value="bought">Kupione</button>
                <button className="btn-secondary" name="to" value="cancelled">Usuń z listy</button>
              </>
            ) : (
              <button className="btn-secondary" name="to" value="active">Przywróć na listę</button>
            )}
          </div>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {items.map((it) => (
              <li key={it.id}>
                <label className="group flex h-full cursor-pointer flex-col rounded-lg border border-line p-2 transition-colors hover:border-accent hover:bg-sky-50 has-[:checked]:border-accent has-[:checked]:bg-sky-50">
                  <div className="flex items-start justify-between">
                    <input type="checkbox" name="ids" value={it.id} className="h-4 w-4" aria-label={`Zaznacz ${it.title} ${it.size ?? ""}`} />
                    <span className="text-xs text-muted">{dateOnly(active ? it.created_at : it.closed_at)}</span>
                  </div>
                  <div className="my-2 flex h-32 items-center justify-center">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {it.image_url ? <img src={`${it.image_url}${it.image_url.includes("?") ? "&" : "?"}width=300`} alt="" className="max-h-32 object-contain" loading="lazy" /> : <span className="text-xs text-muted">brak zdjęcia</span>}
                  </div>
                  <div className="line-clamp-2 text-sm font-medium">{it.title}</div>
                  <div className="mt-1 flex items-baseline justify-between gap-2">
                    <span className="text-lg font-bold">{it.size ?? "–"}</span>
                    <span className="truncate font-mono text-xs text-muted">{it.sku ?? ""}</span>
                  </div>
                  {it.note && <div className="mt-1 text-xs text-muted">{it.order_id ? <Link className="relative z-10 underline" href={`/sprzedaz/${it.order_id}`}>{it.note}</Link> : it.note}</div>}
                </label>
                {active && (
                  <details className="mt-1 rounded-md border border-line bg-white px-2 py-1 text-xs">
                    <summary className="cursor-pointer text-accent">Zmień nazwę / rozmiar</summary>
                    <div className="mt-1 space-y-1">
                      <input className="input py-1 text-xs" name="title" form={`wtb-edit-${it.id}`} defaultValue={it.title} aria-label="Nazwa" />
                      <div className="flex gap-1">
                        <input className="input py-1 text-xs" name="size" form={`wtb-edit-${it.id}`} defaultValue={it.size ?? ""} placeholder="rozmiar" aria-label="Rozmiar" />
                        <input className="input py-1 text-xs" name="sku" form={`wtb-edit-${it.id}`} defaultValue={it.sku ?? ""} placeholder="SKU" aria-label="SKU" />
                      </div>
                      <button className="btn-secondary w-full px-2 py-1 text-xs" form={`wtb-edit-${it.id}`}>Zapisz</button>
                    </div>
                  </details>
                )}
              </li>
            ))}
          </ul>
        </form>
      )}
      {/* Formularze edycji pozycji (poza główną listą – pola wskazują je atrybutem form). */}
      {active && items?.map((it) => (
        <form key={it.id} id={`wtb-edit-${it.id}`} action={editWtbItem} className="hidden"><input type="hidden" name="id" value={it.id} /><input type="hidden" name="back" value={back} /></form>
      ))}
    </>
  );
}
