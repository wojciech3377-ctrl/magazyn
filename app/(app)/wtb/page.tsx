import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { dateOnly } from "@/lib/labels";
import { Notice, PageHeader } from "@/components/ui";
import { SelectAll } from "@/components/SelectAll";
import { WtbAdd } from "./WtbAdd";
import { editWtbGroup, updateWtb } from "./actions";
import { GroupCheck, WtbTile, WtbCopyList, WtbEditDialog, WtbPhotoButton } from "./WtbControls";
import { groupWtb, joinSizes } from "@/lib/wtb-group";
import { isWtbPhoto, wtbDisplayUrls } from "@/lib/wtb-photo";

const TABS = [
  { key: "", label: "Szukamy", status: "active" },
  { key: "kupione", label: "Kupione", status: "bought" },
] as const;

export default async function WtbPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { supabase } = await requireProfile();
  const tab = TABS.find((t) => t.key === (sp.widok ?? "")) ?? TABS[0];
  const [{ data: items }, ...counts] = await Promise.all([
    supabase.from("wtb_items").select("*").eq("status", tab.status)
      .order(tab.status === "active" ? "created_at" : "closed_at", { ascending: tab.status === "active" }).limit(500),
    ...TABS.map((t) => supabase.from("wtb_items").select("id", { count: "exact", head: true }).eq("status", t.status)),
  ]);
  const back = tab.key ? `/wtb?widok=${tab.key}` : "/wtb";
  const active = tab.status === "active";
  const groups = groupWtb(items ?? []);
  const shown = await wtbDisplayUrls(groups.map((g) => g.image_url), 300);
  // Wersja podglądu grafiki – zmienia się po każdej zmianie listy (nazwa, rozmiary, pozycje).
  let h = 0;
  for (const ch of (items ?? []).map((i) => `${i.id}${i.title}${i.size}${i.sku}${i.image_url}`).join("|")) h = (h * 31 + ch.charCodeAt(0)) | 0;
  const version = `${items?.length ?? 0}-${(h >>> 0).toString(36)}`;

  return (
    <>
      <PageHeader
        title="WTB – szukamy"
        sub="Buty, które chcemy odkupić – jeden model na karcie z rozmiarami pod spodem. Zaznacz model albo pojedyncze rozmiary i zrób grafikę „SNEAKERS DEPOT WTB” (do 30 modeli na jednej grafice)."
        actions={active && items?.length ? <Link className="btn" href="/wtb/grafika">Grafika z całej listy ({groups.length} {groups.length === 1 ? "model" : "modeli"})</Link> : null}
      />
      {sp.ok && <div className="mb-4"><Notice tone="ok">{sp.ok}</Notice></div>}
      {sp.blad && <div className="mb-4"><Notice tone="error">{sp.blad}</Notice></div>}

      {active && (
        <div className="mb-5 grid gap-5 lg:grid-cols-[1fr_320px]">
          <WtbAdd />
          {!!items?.length && (
            <Link href="/wtb/grafika" className="group block rounded-lg border border-line bg-white p-2 transition hover:border-accent hover:shadow-md" title="Podgląd grafiki z całej listy">
              <span className="mb-1 block text-xs font-medium text-muted group-hover:text-accent">Podgląd grafiki z całej listy{groups.length > 30 ? " (pierwsza z kilku)" : ""} →</span>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/wtb?strona=1&v=${version}`} alt="Podgląd grafiki WTB" className="w-full rounded" loading="lazy" />
            </Link>
          )}
        </div>
      )}

      {active && groups.length > 0 && (
        <div className="mb-5">
          <WtbCopyList lines={groups.map((g) => [g.used ? `${g.title} (USED)` : g.title, g.sku, joinSizes(g.sizes)].filter((x) => x && String(x).trim()).join(" - "))} />
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
          <div className="sticky top-14 z-20 lg:top-0 mb-3 flex flex-wrap items-center gap-2 border-b border-line bg-white/95 py-2 backdrop-blur">
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
          <ul className="grid grid-cols-2 items-start gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {groups.map((g) => {
              const first = g.items[0];
              const notes = [...new Map(g.items.filter((i) => i.note).map((i) => [i.note, i])).values()];
              return (
                <WtbTile key={g.key} className="flex flex-col rounded-lg border border-line bg-white p-2 transition-colors hover:border-accent has-[:checked]:border-accent has-[:checked]:bg-sky-50">
                  <div className="flex items-start justify-between gap-2">
                    <GroupCheck label={g.title} />
                    <span className="text-xs text-muted">{dateOnly(active ? first.created_at : first.closed_at)}</span>
                  </div>
                  <div className="relative my-2 flex h-32 items-center justify-center">
                    {g.used && <span className="absolute left-0 top-0 rounded bg-ink px-2 py-0.5 text-xs font-bold tracking-wider text-white shadow">USED</span>}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {g.image_url && shown.get(g.image_url) ? <img src={shown.get(g.image_url)} alt="" className="max-h-32 object-contain" loading="lazy" /> : <span className="text-xs text-muted">brak zdjęcia</span>}
                  </div>
                  <div className="line-clamp-2 text-sm font-medium">{g.used && <span className="mr-1.5 inline-block rounded bg-ink px-1.5 py-px align-middle text-[10px] font-bold tracking-wider text-white">USED</span>}{g.title}</div>
                  {g.sku && <div className="truncate font-mono text-xs text-muted">{g.sku}</div>}
                  <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label={`Rozmiary: ${g.title}`}>
                    {g.items.map((it) => (
                      <label key={it.id} className="cursor-pointer rounded-md border border-line bg-white px-2 py-0.5 text-sm font-bold tabular-nums transition-colors hover:border-accent has-[:checked]:border-accent has-[:checked]:bg-accent has-[:checked]:text-white" title="Zaznacz ten rozmiar">
                        <input type="checkbox" name="ids" value={it.id} className="sr-only" aria-label={`Zaznacz ${g.title} ${it.size ?? ""}`} />
                        {it.size ?? "bez rozmiaru"}
                      </label>
                    ))}
                  </div>
                  {notes.map((it) => (
                    <div key={it.id} className="mt-1 text-xs text-muted">{it.order_id ? <Link className="underline" href={`/sprzedaz/${it.order_id}`}>{it.note}</Link> : it.note}</div>
                  ))}
                  {active && (
                    <div className="mt-2 flex flex-col items-start gap-0.5 border-t border-line pt-1">
                      <WtbEditDialog formId={`wtb-edit-${g.items[0].id}`} title={g.title} sku={g.sku} used={g.used} sizes={g.items.map((i) => i.size ?? "").filter(Boolean)} />
                      <WtbPhotoButton ids={g.ids} custom={isWtbPhoto(g.image_url)} label={g.title} />
                    </div>
                  )}
                </WtbTile>
              );
            })}
          </ul>
        </form>
      )}
      {/* Formularze edycji pozycji (poza główną listą – pola wskazują je atrybutem form). */}
      {active && groups.map((g) => (
        <form key={g.key} id={`wtb-edit-${g.items[0].id}`} action={editWtbGroup} className="hidden">
          {g.ids.map((id) => <input key={id} type="hidden" name="ids" value={id} />)}
          <input type="hidden" name="back" value={back} />
        </form>
      ))}
    </>
  );
}
