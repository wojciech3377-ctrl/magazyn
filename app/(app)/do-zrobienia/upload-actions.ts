"use server";

import { requireProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { signUploadPath } from "@/lib/contracts/upload";

/** Dozwolone pliki przy zadaniu (typ → rozszerzenie). */
const EXT: Record<string, string> = {
  "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "image/heif": "heif", "image/gif": "gif",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx", "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx", "application/vnd.ms-excel": "xls",
  "text/csv": "csv", "text/plain": "txt",
};

/** Jednorazowy adres do wgrania pliku zadania prosto do Storage (bez limitu wielkości zapytania na Vercel). */
export async function prepareTaskUpload(type: string, size: number): Promise<{ path: string; token: string; sig: string } | { error: string }> {
  await requireProfile();
  const ext = EXT[type];
  if (!ext) return { error: "Ten rodzaj pliku nie jest obsługiwany – wybierz zdjęcie, PDF, Word, Excel albo tekst." };
  if (!(size > 0) || size > 25 * 1024 * 1024) return { error: "Plik może mieć najwyżej 25 MB." };
  const now = new Date();
  const path = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${crypto.randomUUID()}.${ext}`;
  const { data, error } = await createAdminClient().storage.from("task-files").createSignedUploadUrl(path);
  if (error || !data) return { error: /bucket|not found/i.test(error?.message ?? "") ? "Pliki przy zadaniach wymagają SQL 82 w Supabase (0082_task_files.sql)." : `Nie można przygotować wgrania pliku: ${error?.message ?? "błąd"}` };
  return { path, token: data.token, sig: signUploadPath(path, "task") };
}
