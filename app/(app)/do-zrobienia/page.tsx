import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { Notice, PageHeader } from "@/components/ui";
import { AddTask, TaskItem, type Person, type Task } from "./TaskForms";

export const metadata = { title: "Do zrobienia" };

const COLORS = ["bg-blue-100 text-blue-700", "bg-emerald-100 text-emerald-700", "bg-amber-100 text-amber-800", "bg-rose-100 text-rose-700", "bg-violet-100 text-violet-700", "bg-cyan-100 text-cyan-800"];
const TABS = [
  { key: "", label: "Moje" },
  { key: "wszystkie", label: "Wszystkie otwarte" },
  { key: "zrobione", label: "Zrobione" },
] as const;

/** Do zrobienia: zadania z przypisanymi pracownikami (bez przypisania – dla wszystkich). */
export default async function TodoPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { supabase, profile } = await requireProfile();
  const tab = TABS.find((t) => t.key === sp.widok)?.key ?? "";
  const { data: profiles } = await supabase.from("profiles").select("id, full_name, email, active").order("full_name");
  const people: Person[] = (profiles ?? []).filter((p) => p.active).map((p, i) => {
    const name = (p.full_name as string | null) || (p.email as string | null)?.split("@")[0] || "?";
    return { id: p.id as string, name, initials: name.split(/[\s.]+/).filter(Boolean).slice(0, 2).map((x) => x[0]?.toUpperCase()).join(""), color: COLORS[i % COLORS.length] };
  });
  const nameOf = (id: string | null) => (id ? people.find((p) => p.id === id)?.name ?? null : null);

  let q = supabase.from("tasks").select("*");
  if (tab === "zrobione") q = q.not("done_at", "is", null).order("done_at", { ascending: false }).limit(100);
  else q = q.is("done_at", null).order("due_date", { ascending: true, nullsFirst: false }).order("created_at", { ascending: false }).limit(500);
  if (tab === "") q = q.or(`assignees.eq.{},assignees.cs.{${profile.id}}`);
  const { data, error } = await q;
  const tasks = (data ?? []) as Task[];
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });
  const rank = { high: 0, normal: 1, low: 2 };
  const sorted = tab === "zrobione" ? tasks : [...tasks].sort((a, b) =>
    Number(!!b.due_date && b.due_date < today) - Number(!!a.due_date && a.due_date < today)
    || rank[a.priority] - rank[b.priority]
    || (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999"));
  const groups = tab === "zrobione"
    ? [{ title: "", items: sorted }]
    : [
        { title: "Po terminie", items: sorted.filter((t) => t.due_date && t.due_date < today) },
        { title: "Na dziś", items: sorted.filter((t) => t.due_date === today) },
        { title: "Następne", items: sorted.filter((t) => t.due_date && t.due_date > today) },
        { title: "Bez terminu", items: sorted.filter((t) => !t.due_date) },
      ].filter((g) => g.items.length);

  return (
    <>
      <PageHeader title="Do zrobienia" sub="Zadania dla zespołu. Bez wybranych osób zadanie widzą wszyscy pracownicy." />
      {error && <div className="mb-4"><Notice tone="error">Uruchom migrację <b>0040_tasks.sql</b> w Supabase (SQL Editor) – wtedy zadziała lista zadań.</Notice></div>}
      <div className="mx-auto max-w-3xl space-y-4">
        <AddTask people={people} />
        <nav className="segmented" aria-label="Zadania">
          {TABS.map((t) => <Link key={t.key} href={t.key ? `/do-zrobienia?widok=${t.key}` : "/do-zrobienia"} aria-current={tab === t.key ? "page" : undefined}>{t.label}</Link>)}
        </nav>
        {!sorted.length && !error && (
          <p className="py-12 text-center text-sm text-muted">{tab === "zrobione" ? "Nic jeszcze nie zostało zrobione." : "Nic do zrobienia. 🎉"}</p>
        )}
        {groups.map((g) => (
          <section key={g.title || "all"}>
            {g.title && <h2 className={`mb-2 text-xs font-semibold uppercase tracking-wider ${g.title === "Po terminie" ? "text-bad" : "text-muted"}`}>{g.title} · {g.items.length}</h2>}
            <ul className="space-y-2">
              {g.items.map((t) => (
                <TaskItem key={t.id} t={t} people={people} canDelete={t.created_by === profile.id || profile.role === "admin"}
                  doneByName={nameOf(t.done_by)} authorName={t.created_by === profile.id ? null : nameOf(t.created_by)} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}
