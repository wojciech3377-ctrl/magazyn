"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { nextDue, nextOccurrence, REPEATS, type Repeat } from "./repeat";
import { verifyUploadPath } from "@/lib/contracts/upload";
import { createAdminClient } from "@/lib/supabase/admin";

export type TaskFile = { path: string; name: string; size: number | null; type: string | null };

/** Nowe pliki z formularza (wgrane przez prepareTaskUpload – ścieżka z podpisem serwera) i zostawione stare. */
function readFiles(fd: FormData, existing: TaskFile[] = []): TaskFile[] {
  const paths = fd.getAll("file_path").map(String);
  const names = fd.getAll("file_name").map(String);
  const sigs = fd.getAll("file_sig").map(String);
  const sizes = fd.getAll("file_size").map(String);
  const types = fd.getAll("file_type").map(String);
  const added = paths.flatMap((path, i) => verifyUploadPath(path, sigs[i], "task")
    ? [{ path, name: (names[i] || path.split("/").pop()!).slice(0, 200), size: Number(sizes[i]) || null, type: (types[i] || "").slice(0, 120) || null }]
    : []);
  const keep = new Set(fd.getAll("keep_file").map(String));
  const kept = existing.filter((f) => keep.has(f.path));
  return [...kept, ...added.filter((a) => !kept.some((k) => k.path === a.path))].slice(0, 20);
}

/** Pliki usunięte z zadania – ze Storage, gdy żadne inne zadanie (np. powtórzenie) ich nie używa. */
async function dropUnusedFiles(paths: string[]) {
  if (!paths.length) return;
  const db = createAdminClient();
  const unused: string[] = [];
  for (const path of paths) {
    const { data } = await db.from("tasks").select("id").contains("files", JSON.stringify([{ path }])).limit(1);
    if (!data?.length) unused.push(path);
  }
  if (unused.length) await db.storage.from("task-files").remove(unused).then(() => null, () => null);
}

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
  const files = readFiles(fd);
  const toInsert: Record<string, unknown> = files.length ? { ...row, files } : { ...row };
  let { error } = await supabase.from("tasks").insert(toInsert);
  if (error && files.length && /files/.test(error.message)) return { error: "Pliki przy zadaniach wymagają SQL 82 w Supabase (0082_task_files.sql)." };
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
      ...(Array.isArray(t.files) && t.files.length ? { files: t.files } : {}),
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
  const { data: cur } = await supabase.from("tasks").select("*").eq("id", id).maybeSingle();
  const before = (Array.isArray(cur?.files) ? cur!.files : []) as TaskFile[];
  const files = cur && "files" in cur ? readFiles(fd, before) : null;
  const toUpdate: Record<string, unknown> = files ? { ...row, files } : { ...row };
  const { error } = await supabase.from("tasks").update(toUpdate).eq("id", id);
  if (error && missingColumns(error.message)) await supabase.from("tasks").update(legacy(row)).eq("id", id);
  if (!error && files) await dropUnusedFiles(before.filter((b) => !files.some((f) => f.path === b.path)).map((b) => b.path));
  refresh();
}

/** Usunięcie: autor zadania albo administrator. */
export async function deleteTask(fd: FormData) {
  const { supabase, profile } = await requireProfile();
  const id = String(fd.get("id"));
  const { data: t } = await supabase.from("tasks").select("*").eq("id", id).maybeSingle();
  if (!t || (t.created_by !== profile.id && profile.role !== "admin")) return;
  const { error } = await supabase.from("tasks").delete().eq("id", id);
  if (!error) await dropUnusedFiles(((Array.isArray(t.files) ? t.files : []) as TaskFile[]).map((f) => f.path));
  refresh();
}
