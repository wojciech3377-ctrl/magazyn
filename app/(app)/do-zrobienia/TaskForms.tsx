"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { SubmitButton } from "@/components/SubmitButton";
import { addTask, deleteTask, toggleTask, updateTask, type TaskState } from "./actions";
import { REPEATS, type Repeat } from "./repeat";

export type Person = { id: string; name: string; initials: string; color: string };
export type Task = {
  id: string; title: string; notes: string | null; assignees: string[]; start_date?: string | null; due_date: string | null; repeat?: Repeat | null; priority: "low" | "normal" | "high";
  done_at: string | null; done_by: string | null; created_by: string | null; created_at: string;
};

const PRIORITY = { high: "Pilne", normal: "Normalne", low: "Bez pośpiechu" } as const;

/** Wybór osób: kafelki z inicjałami. Nic nie zaznaczone = wszyscy. */
function AssigneePicker({ people, initial = [] }: { people: Person[]; initial?: string[] }) {
  const [sel, setSel] = useState<Set<string>>(new Set(initial));
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-muted">Dla kogo</span>
        <span className="text-xs text-muted">{sel.size ? `${sel.size} ${sel.size === 1 ? "osoba" : "osoby"}` : "nikogo nie zaznaczysz → wszyscy"}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" onClick={() => setSel(new Set())}
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm transition-colors ${sel.size === 0 ? "border-accent bg-accent text-white" : "border-line bg-white hover:border-slate-300"}`}>
          <Icon name="users" className="h-3.5 w-3.5" /> Wszyscy
        </button>
        {people.map((p) => {
          const on = sel.has(p.id);
          return (
            <button type="button" key={p.id} onClick={() => toggle(p.id)} aria-pressed={on}
              className={`inline-flex items-center gap-1.5 rounded-full border py-1 pl-1 pr-2.5 text-sm transition-colors ${on ? "border-accent bg-accent-soft text-accent" : "border-line bg-white hover:border-slate-300"}`}>
              <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold ${p.color}`}>{p.initials}</span>
              {p.name}
              {on && <Icon name="check" className="h-3.5 w-3.5" />}
            </button>
          );
        })}
      </div>
      {[...sel].map((id) => <input key={id} type="hidden" name="assignee" value={id} />)}
    </div>
  );
}

const todayPl = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });
const dayLabel = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("pl-PL", { day: "numeric", month: "short" });

function Fields({ people, t }: { people: Person[]; t?: Task }) {
  const [start, setStart] = useState(t?.start_date ?? todayPl());
  const [repeat, setRepeat] = useState<Repeat>(t?.repeat ?? "none");
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_11rem]">
        <input className="input" name="title" defaultValue={t?.title} placeholder="Co jest do zrobienia?" aria-label="Zadanie" required maxLength={300} autoFocus={!t} />
        <select className="input" name="priority" defaultValue={t?.priority ?? "normal"} aria-label="Priorytet">
          {Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <label className="block"><span className="mb-1 block text-xs font-medium text-muted">Od</span>
          <input className="input" type="date" name="start_date" value={start} onChange={(e) => setStart(e.target.value)} required /></label>
        <label className="block"><span className="mb-1 block text-xs font-medium text-muted">Do (termin, opcjonalnie)</span>
          <input className="input" type="date" name="due_date" defaultValue={t?.due_date ?? ""} min={start} /></label>
        <label className="col-span-2 block sm:col-span-1"><span className="mb-1 block text-xs font-medium text-muted">Powtarzaj</span>
          <span className="relative block">
            <Icon name="repeat" className={`pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 ${repeat !== "none" ? "text-accent" : "text-slate-400"}`} />
            <select className={`input pl-9 ${repeat !== "none" ? "border-accent/50 text-accent" : ""}`} name="repeat" value={repeat} onChange={(e) => setRepeat(e.target.value as Repeat)}>
              {REPEATS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
          </span>
        </label>
      </div>
      {repeat !== "none" && <p className="-mt-1 text-xs text-muted">Po oznaczeniu jako zrobione pojawi się kolejne zadanie ({REPEATS.find((r) => r.key === repeat)?.short}).</p>}
      <textarea className="input min-h-16" name="notes" defaultValue={t?.notes ?? ""} placeholder="Szczegóły (opcjonalnie)" aria-label="Szczegóły" maxLength={2000} />
      <AssigneePicker people={people} initial={t?.assignees} />
    </div>
  );
}

export function AddTask({ people }: { people: Person[] }) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState<TaskState, FormData>(addTask, null);
  const form = useRef<HTMLFormElement>(null);
  const [key, setKey] = useState(0);
  useEffect(() => { if (state?.ok) { setKey((k) => k + 1); form.current?.reset(); } }, [state]);
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="card flex w-full items-center gap-3 p-4 text-left text-muted transition-colors hover:border-accent/50 hover:text-ink">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-white"><Icon name="plus" className="h-4 w-4" /></span>
        Dodaj zadanie…
        {state?.ok && <span className="ml-auto text-sm text-ok">{state.ok}</span>}
      </button>
    );
  }
  return (
    <form ref={form} action={action} className="card space-y-3 p-4">
      <Fields key={key} people={people} />
      {state?.error && <p className="text-sm text-bad">{state.error}</p>}
      {state?.ok && <p className="text-sm text-ok">{state.ok}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Zamknij</button>
        <SubmitButton pendingText="Dodaję…">Dodaj zadanie</SubmitButton>
      </div>
    </form>
  );
}

export function TaskItem({ t, people, canDelete, doneByName, authorName }: { t: Task; people: Person[]; canDelete: boolean; doneByName: string | null; authorName: string | null }) {
  const [edit, setEdit] = useState(false);
  const done = !!t.done_at;
  const today = todayPl();
  const overdue = !done && !!t.due_date && t.due_date < today;
  const isToday = !done && t.due_date === today;
  const who = t.assignees.map((id) => people.find((p) => p.id === id)).filter((p): p is Person => !!p);
  const toggleForm = useRef<HTMLFormElement>(null);

  if (edit) {
    return (
      <li className="card p-4">
        <form action={async (fd) => { await updateTask(fd); setEdit(false); }} className="space-y-3">
          <input type="hidden" name="id" value={t.id} />
          <Fields people={people} t={t} />
          <div className="flex flex-wrap justify-between gap-2">
            {canDelete ? (
              <button type="submit" formAction={deleteTask} className="btn-ghost text-bad" onClick={(e) => { if (!confirm("Usunąć zadanie?")) e.preventDefault(); }}>Usuń</button>
            ) : <span />}
            <span className="flex gap-2">
              <button type="button" className="btn-ghost" onClick={() => setEdit(false)}>Anuluj</button>
              <SubmitButton pendingText="Zapisuję…">Zapisz</SubmitButton>
            </span>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li className={`card flex items-start gap-3 p-3.5 sm:p-4 ${done ? "bg-slate-50/70" : ""} ${t.priority === "high" && !done ? "border-l-4 border-l-red-400" : ""}`}>
      <form ref={toggleForm} action={toggleTask}>
        <input type="hidden" name="id" value={t.id} />
        <input type="hidden" name="done" value={done ? "0" : "1"} />
        <button className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${done ? "border-emerald-500 bg-emerald-500 text-white" : "border-slate-300 hover:border-emerald-500"}`} aria-label={done ? "Oznacz jako niezrobione" : "Oznacz jako zrobione"}>
          {done && <Icon name="check" className="h-3.5 w-3.5" />}
        </button>
      </form>
      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setEdit(true)} title="Kliknij, żeby zmienić">
        <span className={`block font-medium leading-snug ${done ? "text-muted line-through" : ""}`}>{t.title}</span>
        {t.notes && <span className={`mt-0.5 block whitespace-pre-line text-sm ${done ? "text-slate-400" : "text-muted"}`}>{t.notes}</span>}
        <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          {(t.start_date || t.due_date) && (
            <span className={overdue ? "font-semibold text-bad" : isToday ? "font-semibold text-warn" : ""}>
              {overdue ? "po terminie · " : isToday ? "termin dziś · " : ""}
              {t.start_date && t.start_date > today ? `od ${dayLabel(t.start_date)}` : ""}
              {t.start_date && t.start_date > today && t.due_date ? " " : ""}
              {t.due_date ? `do ${dayLabel(t.due_date)}` : ""}
            </span>
          )}
          {t.repeat && t.repeat !== "none" && <span className="inline-flex items-center gap-1 text-accent"><Icon name="repeat" className="h-3.5 w-3.5" />{REPEATS.find((r) => r.key === t.repeat)?.short}</span>}
          {t.priority === "high" && !done && <span className="font-semibold text-bad">pilne</span>}
          <span className="inline-flex items-center gap-1">
            {who.length ? (
              <span className="flex -space-x-1.5">{who.slice(0, 5).map((p) => <span key={p.id} title={p.name} className={`flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold ring-2 ring-white ${p.color}`}>{p.initials}</span>)}</span>
            ) : <span className="inline-flex items-center gap-1"><Icon name="users" className="h-3.5 w-3.5" /> wszyscy</span>}
            {who.length === 1 && <span>{who[0].name}</span>}
          </span>
          {done ? <span>zrobione{doneByName ? ` przez ${doneByName}` : ""}</span> : authorName && <span>od {authorName}</span>}
        </span>
      </button>
    </li>
  );
}
