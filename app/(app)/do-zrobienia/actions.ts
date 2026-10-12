"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";

export type TaskState = { error?: string; ok?: string } | null;

const UUID = /^[0-9a-f-]{36}$/;

/** Nowe zadanie. Bez zaznaczonych osób – dla wszystkich pracowników. */
export async function addTask(_: TaskState, fd: FormData): Promise<TaskState> {
  const { supabase } = await requireProfile();
  const title = String(fd.get("title") ?? "").trim().slice(0, 300);
  if (!title) return { error: "Wpisz, co jest do zrobienia." };
  const due = String(fd.get("due_date") ?? "");
  const priority = ["low", "normal", "high"].includes(String(fd.get("priority"))) ? String(fd.get("priority")) : "normal";
  const assignees = [...new Set(fd.getAll("assignee").map(String).filter((x) => UUID.test(x)))];
  const { error } = await supabase.from("tasks").insert({
    title,
    notes: String(fd.get("notes") ?? "").trim().slice(0, 2000) || null,
    due_date: /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : null,
    priority,
    assignees,
  });
  if (error) return { error: /tasks/.test(error.message) ? "Uruchom migrację 0040 w Supabase (SQL Editor)." : error.message };
  revalidatePath("/do-zrobienia");
  revalidatePath("/", "layout");
  return { ok: assignees.length ? "Dodano zadanie." : "Dodano zadanie dla wszystkich." };
}

/** Zrobione / do zrobienia. */
export async function toggleTask(fd: FormData) {
  const { supabase, profile } = await requireProfile();
  const id = String(fd.get("id"));
  const done = fd.get("done") === "1";
  await supabase.from("tasks").update(done ? { done_at: new Date().toISOString(), done_by: profile.id } : { done_at: null, done_by: null }).eq("id", id);
  revalidatePath("/do-zrobienia");
  revalidatePath("/", "layout");
}

/** Zmiana treści, terminu i osób. */
export async function updateTask(fd: FormData) {
  const { supabase } = await requireProfile();
  const id = String(fd.get("id"));
  const title = String(fd.get("title") ?? "").trim().slice(0, 300);
  if (!title) return;
  const due = String(fd.get("due_date") ?? "");
  await supabase.from("tasks").update({
    title,
    notes: String(fd.get("notes") ?? "").trim().slice(0, 2000) || null,
    due_date: /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : null,
    priority: ["low", "normal", "high"].includes(String(fd.get("priority"))) ? String(fd.get("priority")) : "normal",
    assignees: [...new Set(fd.getAll("assignee").map(String).filter((x) => UUID.test(x)))],
  }).eq("id", id);
  revalidatePath("/do-zrobienia");
  revalidatePath("/", "layout");
}

/** Usunięcie: autor zadania albo administrator. */
export async function deleteTask(fd: FormData) {
  const { supabase, profile } = await requireProfile();
  const id = String(fd.get("id"));
  const { data: t } = await supabase.from("tasks").select("created_by").eq("id", id).maybeSingle();
  if (!t || (t.created_by !== profile.id && profile.role !== "admin")) return;
  await supabase.from("tasks").delete().eq("id", id);
  revalidatePath("/do-zrobienia");
  revalidatePath("/", "layout");
}
