import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { shopifyMatches, unassignedGroups, normOption } from "@/lib/unassigned";
import { assignUnitToShopify } from "../magazyn/actions";
import { SubmitButton } from "@/components/SubmitButton";
import { UNIT_STATUS } from "@/lib/labels";

/**
 * Do zrobienia → rzeczy „nieprzypisane do Shopify” (np. z umowy, zanim produkt powstał w Shopify).
 * Gdy w Shopify jest już pasujący produkt – podpowiedź do ręcznego zatwierdzenia (bez automatu).
 */
export async function UnassignedTodo() {
  const db = createAdminClient();
  const groups = await unassignedGroups(db);
  if (!groups.length) return null;
  const withMatch = await Promise.all(groups.map(async (g) => {
    const first = g.units[0];
    const matches = g.storeId ? await shopifyMatches(db, g.title, first.option, g.storeId, 3).catch(() => []) : [];
    return { g, match: matches.find((m) => m.sameSize) ?? null };
  }));
  const total = groups.reduce((n, g) => n + g.units.length, 0);
  return (
    <section>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-bad">Nieprzypisane do Shopify · {total} szt.</h2>
      <ul className="space-y-2">
        {withMatch.map(({ g, match }) => {
          const target = match ? g.units.find((u) => normOption(u.option) === normOption(match.sameSize!.option)) ?? g.units[0] : null;
          return (
            <li key={g.productId} className={`card p-3 ${match ? "border-emerald-300 bg-emerald-50/40" : "border-orange-200"}`}>
              <div className="flex flex-wrap items-center gap-2">
                <b className="min-w-0 flex-1">{g.title}</b>
                {g.storeName && <span className="text-xs text-muted">{g.storeName}</span>}
              </div>
              <ul className="mt-1 space-y-0.5 text-sm">
                {g.units.map((u) => (
                  <li key={u.id} className="flex flex-wrap items-center gap-x-2">
                    <Link className="font-mono text-xs text-accent hover:underline" href={`/magazyn/${u.id}`}>{u.code}</Link>
                    <b>{u.option}</b>
                    <span className="text-xs text-muted">{UNIT_STATUS[u.status] ?? u.status}{u.contract ? ` · umowa ${u.contract}` : " · bez umowy"}{u.supplier ? ` · od: ${u.supplier}` : ""}</span>
                  </li>
                ))}
              </ul>
              {match && target ? (
                <form action={assignUnitToShopify} className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                  <input type="hidden" name="id" value={target.id} />
                  <input type="hidden" name="variant_id" value={match.sameSize!.id} />
                  <input type="hidden" name="back" value="/do-zrobienia" />
                  {g.units.length > 1 && <input type="hidden" name="all" value="1" />}
                  <span>W Shopify jest już pasujący produkt: <b>{match.title}</b>. Sprawdź i zatwierdź:</span>
                  <SubmitButton className="btn h-8 px-3 text-xs" pendingText="Łączę…">Zatwierdź – połącz{g.units.length > 1 ? ` (${g.units.length} szt., po rozmiarach)` : ""}</SubmitButton>
                  <Link className="text-xs text-accent underline" href={`/magazyn/${target.id}`}>inny produkt…</Link>
                </form>
              ) : (
                <p className="mt-2 text-xs text-muted">Brak tego produktu w Shopify – dodaj go w Shopify (stan 0), a tu pojawi się podpowiedź do zatwierdzenia. <Link className="text-accent underline" href={`/magazyn/${g.units[0].id}`}>Karta sztuki</Link></p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
