import { addTransitNote, editTransitNote, toggleTransitNote } from "./transit-doc-actions";
import { SubmitButton } from "@/components/SubmitButton";
import { dateTime } from "@/lib/labels";

export type TransitNote = { id: string; text: string; created_at: string; arrived_at: string | null; author: string | null; arrivedBy: string | null; mine?: boolean };

/** W drodze → notatki z „Doszło” (np. paczka bez rzeczy w magazynie). Doszłe – szare, widoczne 7 dni. */
export function TransitNotes({ notes, isAdmin = false }: { notes: TransitNote[]; isAdmin?: boolean }) {
  const open = notes.filter((n) => !n.arrived_at);
  const done = notes.filter((n) => n.arrived_at);
  return (
    <div className="card space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <b>Notatki – co ma przyjść</b>
        <span className="text-sm text-muted">{open.length ? `${open.length} czeka` : "nic nie czeka"}</span>
      </div>
      <form action={addTransitNote} className="flex flex-wrap gap-2">
        <input name="text" className="input min-w-64 flex-1" placeholder="np. paczka od Kowalskiego – 2 pary Jordan 4, kurier DPD" maxLength={500} aria-label="Treść notatki" />
        <SubmitButton className="btn-secondary" pendingText="…">Dodaj notatkę</SubmitButton>
      </form>
      {(open.length > 0 || done.length > 0) && (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {[...open, ...done].map((n) => (
            <li key={n.id} className={`flex flex-wrap items-center gap-3 px-3 py-2 text-sm ${n.arrived_at ? "bg-panel text-muted" : ""}`}>
              <form action={toggleTransitNote}>
                <input type="hidden" name="id" value={n.id} />
                <input type="hidden" name="arrived" value={n.arrived_at ? "0" : "1"} />
                <button className={`flex items-center gap-2 rounded-md border px-2 py-1 text-xs font-medium ${n.arrived_at ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-line bg-white hover:border-emerald-400"}`}
                  aria-pressed={!!n.arrived_at} title={n.arrived_at ? "Odznacz" : "Zaznacz, że doszło"}>
                  <span className={`inline-block h-4 w-4 rounded border text-center leading-3 ${n.arrived_at ? "border-emerald-600 bg-emerald-600 text-white" : "border-slate-400"}`}>{n.arrived_at ? "✓" : ""}</span>
                  Doszło
                </button>
              </form>
              {isAdmin ? (
                <details className="min-w-0 flex-1">
                  <summary className={`cursor-pointer list-none ${n.arrived_at ? "line-through" : ""}`} title="Kliknij, żeby edytować">{n.text} <span className="text-xs text-accent no-underline">edytuj</span></summary>
                  <form action={editTransitNote} className="mt-2 flex flex-wrap gap-2">
                    <input type="hidden" name="id" value={n.id} />
                    <input name="text" defaultValue={n.text} maxLength={500} className="input min-w-64 flex-1" aria-label="Treść notatki" />
                    <SubmitButton className="btn-secondary" pendingText="…">Zapisz</SubmitButton>
                  </form>
                </details>
              ) : <span className={`min-w-0 flex-1 ${n.arrived_at ? "line-through" : ""}`}>{n.text}</span>}
              <span className="text-xs text-muted">
                {dateTime(n.created_at)}{n.author ? ` · ${n.author}` : ""}{n.arrived_at ? ` · doszło ${dateTime(n.arrived_at)}${n.arrivedBy ? ` (${n.arrivedBy})` : ""}` : ""}
              </span>
              {(isAdmin || n.mine) && (
                <form action={toggleTransitNote}>
                  <input type="hidden" name="id" value={n.id} />
                  <input type="hidden" name="delete" value="1" />
                  <button className="text-xs text-muted hover:text-bad" aria-label="Usuń notatkę">usuń</button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
