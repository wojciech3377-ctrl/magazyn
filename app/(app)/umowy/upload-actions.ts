"use server";

import { requireSection } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

const EXT: Record<string, string> = {
  "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "image/heif": "heif",
};

/**
 * Jednorazowy adres do wgrania pliku umowy prosto do Storage (bez limitu wielkości zapytania na Vercel).
 * Przeglądarka nie potrzebuje do tego sesji – ciasteczka logowania mogą być niedostępne dla JavaScriptu.
 */
export async function prepareContractUpload(type: string, size: number): Promise<{ path: string; token: string } | { error: string }> {
  await requireSection("umowy", "dostawa", "komisanci");
  const ext = EXT[type];
  if (!ext) return { error: "Wybierz PDF albo zdjęcie (JPG, PNG, HEIC)." };
  if (!(size > 0) || size > 25 * 1024 * 1024) return { error: "Plik może mieć najwyżej 25 MB." };
  const now = new Date();
  const path = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${crypto.randomUUID()}.${ext}`;
  const { data, error } = await createAdminClient().storage.from("contracts").createSignedUploadUrl(path);
  if (error || !data) return { error: `Nie można przygotować wgrania pliku: ${error?.message ?? "błąd"}` };
  return { path, token: data.token };
}
