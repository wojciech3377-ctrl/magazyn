import { requireAdmin } from "@/lib/auth";
import { SubmitButton } from "@/components/SubmitButton";
import { ConfirmSubmit } from "@/components/ConfirmSubmit";
import { cashMovement, undoCashMovement } from "./cash-actions";
import { withoutMirrors } from "@/lib/stores";

const pln = (n: number) => new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN" }).format(n);
const when = (iso: string) => new Intl.DateTimeFormat("pl-PL", { timeZone: "Europe/Warsaw", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
const KIND: Record<string, string> = { reset: "wyzerowanie (zabrano wszystko)", withdraw: "zabrano", deposit: "wpłata" };

type Row = { store_id: string; balance: number; sales: number; returns: number; last_out_at: string | null; sales_since: number; orders_since: number };
type Move = { id: string; store_id: string; kind: string; amount: number; balance_before: number | null; note: string | null; created_at: string; who: { full_name: string | null; email: string | null } | null };

/** Gotówka w kasie (administrator): stan, sprzedaż gotówką od ostatniego zabrania, wyzerowanie, wypłata, wpłata, historia. */
export async function CashDrawer() {
  const { supabase } = await requireAdmin();
  const [{ data: rows, error }, { data: stores }, { data: moves }] = await Promise.all([
    supabase.rpc("cash_balances"),
    supabase.from("stores").select("*").order("name").then(withoutMirrors),
    supabase.from("cash_movements").select("id, store_id, kind, amount, balance_before, note, created_at, who:profiles(full_name, email)").order("created_at", { ascending: false }).limit(30),
  ]);
  if (error) {
    return <div className="card mb-4 p-4 text-sm text-muted">Gotówka w kasie: uruchom w Supabase SQL 66 (0066_cash_drawer.sql), żeby widzieć stan gotówki i zapisywać, ile zabrano.</div>;
  }
  const byStore = new Map(((rows ?? []) as Row[]).map((r) => [r.store_id, r]));
  // Sklepy z jakimkolwiek ruchem gotówki (albo wszystkie, gdy jeszcze nic nie ma).
  const list = (stores ?? []).filter((s) => { const r = byStore.get(s.id); return r && (Number(r.sales) || Number(r.balance) || (moves ?? []).some((m) => m.store_id === s.id)); });
  const shown = list.length ? list : (stores ?? []).slice(0, 1);
  return (
    <section className="card mb-4 p-4">
      <h2 className="h2 mb-3">Gotówka w kasie</h2>
      <div className="grid gap-4 lg:grid-cols-2">
        {shown.map((s) => {
          const r = byStore.get(s.id);
          const balance = Number(r?.balance ?? 0);
          const mine = ((moves ?? []) as unknown as Move[]).filter((m) => m.store_id === s.id);
          return (
            <div key={s.id} className="space-y-3 rounded-lg border border-line p-3">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div>
                  <div className="text-xs uppercase tracking-wider text-muted">{s.name}</div>
                  <div className={`text-2xl font-semibold tabular-nums ${balance < 0 ? "text-bad" : ""}`}>{pln(balance)}</div>
                  <div className="text-xs text-muted">powinno być w kasie</div>
                </div>
                <div className="text-right text-sm">
                  <div>Sprzedaż gotówką {r?.last_out_at ? `od ${when(r.last_out_at)}` : "(od początku)"}:</div>
                  <div className="font-semibold tabular-nums">{pln(Number(r?.sales_since ?? 0))} <span className="font-normal text-muted">· {r?.orders_since ?? 0} sprzed.</span></div>
                </div>
              </div>
              <form action={cashMovement}>
                <input type="hidden" name="store_id" value={s.id} />
                <input type="hidden" name="kind" value="reset" />
                <ConfirmSubmit className="btn w-full" disabled={balance <= 0} message={`Wyzerować kasę ${s.name}? Zapiszemy, że zabrano całą gotówkę: ${pln(balance)}.`}>Wyzeruj kasę – zabieram wszystko ({pln(Math.max(0, balance))})</ConfirmSubmit>
              </form>
              <form action={cashMovement} className="grid grid-cols-[minmax(0,1fr)_7rem] gap-2 sm:grid-cols-[11rem_7rem_minmax(0,1fr)_auto]">
                <input type="hidden" name="store_id" value={s.id} />
                <select className="input" name="kind" defaultValue="withdraw" aria-label="Rodzaj">
                  <option value="withdraw">Zabieram</option>
                  <option value="deposit">Wpłacam (np. drobne)</option>
                </select>
                <input className="input tabular-nums" name="amount" inputMode="decimal" placeholder="kwota zł" aria-label="Kwota" required />
                <input className="input min-w-0" name="note" placeholder="notatka (opcjonalnie)" aria-label="Notatka" maxLength={200} />
                <SubmitButton className="btn-secondary">Zapisz</SubmitButton>
              </form>
              {mine.length > 0 && (
                <details className="text-sm">
                  <summary className="cursor-pointer text-muted">Historia ({mine.length})</summary>
                  <ul className="mt-2 divide-y divide-line">
                    {mine.map((m, k) => (
                      <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-1.5">
                        <span className="whitespace-nowrap text-muted">{when(m.created_at)}</span>
                        <span className="flex-1">{KIND[m.kind] ?? m.kind} <b className="tabular-nums">{m.kind === "deposit" ? "+" : "−"}{pln(Number(m.amount))}</b>{m.note ? <span className="text-muted"> · {m.note}</span> : null}<span className="block text-xs text-muted">{m.who?.full_name || m.who?.email || ""}{m.balance_before !== null ? ` · było ${pln(Number(m.balance_before))}` : ""}</span></span>
                        {k === 0 && (
                          <form action={undoCashMovement}>
                            <input type="hidden" name="id" value={m.id} />
                            <ConfirmSubmit className="text-xs text-bad hover:underline" message="Cofnąć tę operację (np. pomyłka w kwocie)?">cofnij</ConfirmSubmit>
                          </form>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-muted">Stan = sprzedaż w Kasie płacona gotówką − zwroty z tych sprzedaży + wpłaty − zabrane. Usunięta sprzedaż przestaje się liczyć.</p>
    </section>
  );
}
