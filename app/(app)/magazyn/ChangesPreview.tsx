import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { UNIT_STATUS } from "@/lib/labels";
import type { Changes } from "@/lib/sync/changes";

const EVENT: Record<string, string> = { status: "zmiana statusu", received: "przyjęta", created: "dodana", moved: "przeniesiona", edited: "edycja", contract: "umowa", sold: "sprzedana", reserved: "rezerwacja", returned: "zwrot", price: "cena" };
/** Odmiana: 1 produkt, 2 produkty, 5 produktów. */
const pl = (n: number, one: string, few: string, many: string) => `${n} ${n === 1 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many}`;
const st = (s: string | null) => (s ? UNIT_STATUS[s as keyof typeof UNIT_STATUS] ?? s : null);

/** Rozwijany podgląd zmian po „Sprawdź nowe produkty i stany” (z dziennika synchronizacji). */
export async function ChangesPreview({ id }: { id: string }) {
  if (!/^\d+$/.test(id)) return null;
  const { data } = await createAdminClient().from("sync_log").select("message, created_at").eq("id", id).eq("job", "auto-catalog-changes").maybeSingle();
  if (!data) return null;
  let c: Changes;
  try {
    c = JSON.parse(data.message as string) as Changes;
  } catch {
    return null;
  }
  const total = c.newProducts.length + c.updatedProducts.length + c.newUnits.length + c.unitEvents.length;
  const more = (n: number) => (n > 0 ? <li className="text-muted">…i {n} więcej</li> : null);
  return (
    <details className="card mb-4 p-4" open={total > 0 && total <= 15}>
      <summary className="cursor-pointer select-none text-sm font-medium">
        Co się zmieniło: {total === 0 ? "nic" : [
          c.newProducts.length && pl(c.newProducts.length + c.more.newProducts, "nowy produkt", "nowe produkty", "nowych produktów"),
          c.updatedProducts.length && pl(c.updatedProducts.length + c.more.updatedProducts, "zmieniony produkt", "zmienione produkty", "zmienionych produktów"),
          c.newUnits.length && pl(c.newUnits.length + c.more.newUnits, "nowa sztuka", "nowe sztuki", "nowych sztuk"),
          c.unitEvents.length && pl(c.unitEvents.length + c.more.unitEvents, "zmiana sztuki", "zmiany sztuk", "zmian sztuk"),
        ].filter(Boolean).join(" · ")} <span className="font-normal text-muted">(kliknij, aby rozwinąć)</span>
      </summary>
      <div className="mt-3 grid gap-4 text-sm md:grid-cols-2">
        {c.newProducts.length > 0 && (
          <section>
            <h3 className="mb-1 font-medium">Nowe produkty ze Shopify</h3>
            <ul className="space-y-0.5">{c.newProducts.map((p) => <li key={p.id}>{p.title}</li>)}{more(c.more.newProducts)}</ul>
          </section>
        )}
        {c.updatedProducts.length > 0 && (
          <section>
            <h3 className="mb-1 font-medium">Zmienione produkty (nazwa, cena, rozmiary, zdjęcia)</h3>
            <ul className="space-y-0.5">{c.updatedProducts.map((p) => <li key={p.id}>{p.title}</li>)}{more(c.more.updatedProducts)}</ul>
          </section>
        )}
        {c.newUnits.length > 0 && (
          <section>
            <h3 className="mb-1 font-medium">Nowe sztuki (ze stanów Shopify)</h3>
            <ul className="space-y-0.5">
              {c.newUnits.map((u) => <li key={u.id}><Link className="font-mono text-accent hover:underline" href={`/magazyn/${u.id}`}>{u.code}</Link> · {u.title} {u.option} · {u.place} · {st(u.status)}</li>)}
              {more(c.more.newUnits)}
            </ul>
          </section>
        )}
        {c.unitEvents.length > 0 && (
          <section>
            <h3 className="mb-1 font-medium">Zmiany sztuk</h3>
            <ul className="space-y-0.5">
              {c.unitEvents.map((e) => (
                <li key={e.id}>
                  <span className="font-mono">{e.code}</span> · {e.title} {e.option} · {EVENT[e.type] ?? e.type}
                  {(e.from || e.to) && <span className="text-muted"> ({[st(e.from), st(e.to)].filter(Boolean).join(" → ")})</span>}
                </li>
              ))}
              {more(c.more.unitEvents)}
            </ul>
          </section>
        )}
        {total === 0 && <p className="text-muted">Od kliknięcia nic nie zmieniło się w katalogu ani w stanach.</p>}
      </div>
    </details>
  );
}
