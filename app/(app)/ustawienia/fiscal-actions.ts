"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { newPrinterToken } from "@/lib/fiscal/jobs";
import { errorMessage } from "@/lib/errors";

export type PrinterKeyState = { token?: string; name?: string; error?: string } | null;
const back = (msg: string, ok = true): never => redirect(`/ustawienia?zakladka=drukarka&${ok ? "ok" : "blad"}=${encodeURIComponent(msg)}`);

/** Nowa drukarka: klucz programu pokazany raz (w bazie tylko skrót). */
export async function addPrinter(_: PrinterKeyState, fd: FormData): Promise<PrinterKeyState> {
  await requireAdmin();
  const name = String(fd.get("name") ?? "").trim().slice(0, 60);
  if (!name) return { error: "Podaj nazwę drukarki (np. Kasa Poznań)." };
  const { token, hash } = newPrinterToken();
  const { error } = await createAdminClient().from("fiscal_printers").insert({ name, token_hash: hash });
  if (error) return { error: /fiscal_printers/.test(error.message) ? "Uruchom migrację 0036 w Supabase." : errorMessage(error) };
  revalidatePath("/ustawienia");
  return { token, name };
}

/** Nowy klucz (np. po reinstalacji Windows) – stary przestaje działać. */
export async function regeneratePrinterKey(_: PrinterKeyState, fd: FormData): Promise<PrinterKeyState> {
  await requireAdmin();
  const id = String(fd.get("id") ?? "");
  const { token, hash } = newPrinterToken();
  const { data, error } = await createAdminClient().from("fiscal_printers").update({ token_hash: hash }).eq("id", id).select("name").maybeSingle();
  if (error || !data) return { error: error ? errorMessage(error) : "Nie ma takiej drukarki." };
  return { token, name: data.name as string };
}

export async function togglePrinter(fd: FormData) {
  await requireAdmin();
  const active = fd.get("active") === "1";
  await createAdminClient().from("fiscal_printers").update({ active }).eq("id", String(fd.get("id") ?? ""));
  revalidatePath("/ustawienia");
  back(active ? "Drukarka włączona." : "Drukarka wyłączona – paragony czekają w kolejce.");
}

export async function deletePrinter(fd: FormData) {
  await requireAdmin();
  const { error } = await createAdminClient().from("fiscal_printers").delete().eq("id", String(fd.get("id") ?? ""));
  revalidatePath("/ustawienia");
  back(error ? errorMessage(error) : "Drukarka usunięta.", !error);
}

/** Stawki PTU A–F (procent albo „zw”) i które litery dostają towar 23%, towar w marży i usługi. */
export async function saveFiscalSettings(fd: FormData) {
  await requireAdmin();
  const rates: Record<string, string> = {};
  for (const l of ["A", "B", "C", "D", "E", "F"]) {
    const v = String(fd.get(`rate_${l}`) ?? "").trim().toLowerCase().replace("%", "").replace(".", ",");
    if (!/^(zw|\d{1,2}(,\d)?)$/.test(v)) back(`Stawka ${l}: wpisz procent (np. 23, 8, 0) albo „zw”.`, false);
    rates[l] = v;
  }
  const letter = (k: string) => {
    const v = String(fd.get(k) ?? "").trim().toUpperCase();
    return /^[A-F]$/.test(v) ? v : null;
  };
  const value = { rates, ptu23: letter("ptu23"), ptuMargin: letter("ptuMargin"), ptuService: letter("ptuService") };
  if (!value.ptu23 || !value.ptuMargin || !value.ptuService) back("Wybierz stawki z listy A–F.", false);
  const { error } = await createAdminClient().from("app_settings").upsert({ key: "fiscal", value, updated_at: new Date().toISOString() });
  revalidatePath("/ustawienia");
  back(error ? errorMessage(error) : "Stawki PTU zapisane.", !error);
}

/** „Sprawdź połączenie z drukarką”: zadanie testowe – program sprawdza połączenie, nic nie drukuje. */
export async function testPrinter(fd: FormData) {
  const { profile } = await requireAdmin();
  const { error } = await createAdminClient().from("receipt_jobs").insert({
    source: "test", printer_id: String(fd.get("id") ?? "") || null, lines: [], total: 0, payment: "cash", created_by: profile.id,
  });
  revalidatePath("/ustawienia");
  back(error ? errorMessage(error) : "Zadanie testowe wysłane – wynik pojawi się w tabeli poniżej za kilka sekund (odśwież stronę).", !error);
}

/** Ręczna poprawka numeru wydrukowanego paragonu (np. numer w dobie zamiast numeru wydruku z papieru). */
export async function fixReceiptNumber(fd: FormData) {
  await requireAdmin();
  const id = String(fd.get("id") ?? "");
  const raw = String(fd.get("number") ?? "").replace(/\s/g, "");
  if (!/^[0-9a-f-]{36}$/.test(id)) back("Złe zadanie.", false);
  if (!/^\d{1,12}$/.test(raw)) back("Numer paragonu to same cyfry, np. 000001441.", false);
  const number = raw.padStart(9, "0");
  const db = createAdminClient();
  const { data: job } = await db.from("receipt_jobs").select("id, status").eq("id", id).maybeSingle();
  if (!job || job.status !== "printed") back("Poprawić można tylko numer wydrukowanego paragonu.", false);
  await db.from("receipt_jobs").update({ receipt_number: number }).eq("id", id);
  await db.from("receipts").update({ number }).eq("job_id", id);
  revalidatePath("/ustawienia");
  back(`Numer paragonu poprawiony na ${number}.`);
}
