"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { nextDue, nextOccurrence, REPEATS, type Repeat } from "./repeat";

export type TaskState = { error?: string; ok?: string } | null;

const UUID = /^[0-9a-f-]{36}$/;
const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
const todayPl = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });

/** Pola zadania z formularza: treść, od (domyślnie dziś), do (termin), powtarzanie, osoby (pusto = wszyscy). */
function readTask(fd: FormData) {
  const start = String(fd.get("start_date") ?? "");
  const due = String(fd.get("due_date") ?? "");
  const repeat = String(fd.get("repeat") ?? "none");
  const startDate = isDay(start) ? start : todayPl();
  return {
    title: String(fd.get("title") ?? "").trim().slice(0, 300),
    notes: String(fd.get("notes") ?? "").trim().slice(0, 2000) || null,
    start_date: startDate,
    due_date: isDay(due) && due >= startDate ? due : null,
    repeat: (REPEATS.some((r) => r.key === repeat) ? repeat : "none") as Repeat,
    priority: ["low", "normal", "high"].includes(String(fd.get("priority"))) ? String(fd.get("priority")) : "normal",
    assignees: [...new Set(fd.getAll("assignee").map(String).filter((x) => UUID.test(x)))],
  };
}

/** Bez migracji 0041 (brak kolumn od / powtarzanie) – zapis bez nich. */
const legacy = <T extends { start_date?: unknown; repeat?: unknown }>(row: T) => {
  const { start_date: _s, repeat: _r, ...rest } = row;
  return rest;
};
const missingColumns = (msg: string) => /start_date|repeat/.test(msg);

function refresh() {
  revalidatePath("/do-zrobienia");
  revalidatePath("/", "layout");
}

export async function addTask(_: TaskState, fd: FormData): Promise<TaskState> {
  const { supabase } = await requireProfile();
  const row = readTask(fd);
  if (!row.title) return { error: "Wpisz, co jest do zrobienia." };
  let { error } = await supabase.from("tasks").insert(row);
  if (error && missingColumns(error.message)) ({ error } = await supabase.from("tasks").insert(legacy(row)));
  if (error) return { error: /tasks/.test(error.message) ? "Uruchom migracje 0040 i 0041 w Supabase (SQL Editor)." : error.message };
  refresh();
  return { ok: `Dodano zadanie${row.assignees.length ? "" : " dla wszystkich"}${row.repeat !== "none" ? " (powtarzane)" : ""}.` };
}

/** Zrobione / do zrobienia. Zadanie powtarzane po oznaczeniu jako zrobione tworzy kolejne (następny termin). */
export async function toggleTask(fd: FormData) {
  const { supabase, profile } = await requireProfile();
  const id = String(fd.get("id"));
  const done = fd.get("done") === "1";
  const { data: t } = await supabase.from("tasks").select("*").eq("id", id).maybeSingle();
  if (!t) return;
  await supabase.from("tasks").update(done ? { done_at: new Date().toISOString(), done_by: profile.id } : { done_at: null, done_by: null }).eq("id", id);
  const repeat = (t.repeat ?? "none") as Repeat;
  if (done && !t.done_at && repeat !== "none") {
    const start = (t.start_date as string | null) ?? todayPl();
    const nextStart = nextOccurrence(start, repeat);
    await supabase.from("tasks").insert({
      title: t.title, notes: t.notes, assignees: t.assignees, priority: t.priority, repeat,
      start_date: nextStart, due_date: nextDue(start, (t.due_date as string | null) ?? null, repeat, nextStart), created_by: t.created_by,
    });
  }
  refresh();
}

export async function updateTask(fd: FormData) {
  const { supabase } = await requireProfile();
  const id = String(fd.get("id"));
  const row = readTask(fd);
  if (!row.title) return;
  const { error } = await supabase.from("tasks").update(row).eq("id", id);
  if (error && missingColumns(error.message)) await supabase.from("tasks").update(legacy(row)).eq("id", id);
  refresh();
}

/** Usunięcie: autor zadania albo administrator. */
export async function deleteTask(fd: FormData) {
  const { supabase, profile } = await requireProfile();
  const id = String(fd.get("id"));
  const { data: t } = await supabase.from("tasks").select("created_by").eq("id", id).maybeSingle();
  if (!t || (t.created_by !== profile.id && profile.role !== "admin")) return;
  await supabase.from("tasks").delete().eq("id", id);
  refresh();
}
