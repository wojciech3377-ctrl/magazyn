"use client";

import { FileButton } from "./FileButton";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { prepareContractUpload } from "@/app/(app)/umowy/upload-actions";

const ALLOWED = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
const MAX_BYTES = 25 * 1024 * 1024; // limit bucketu ustawiony w migracji

/**
 * Plik umowy wgrywany z przeglądarki prosto do Supabase Storage (bez limitu rozmiaru zapytania
 * na Vercel). Do formularza trafia tylko ścieżka pliku.
 */
export function ContractFileInput({ label = "Plik umowy (PDF lub zdjęcie)" }: { label?: string }) {
  const [state, setState] = useState<{ path?: string; name?: string; status: "idle" | "uploading" | "done" | "error"; message?: string }>({ status: "idle" });

  async function onChange(file: File | undefined) {
    if (!file) return setState({ status: "idle" });
    if (!ALLOWED.includes(file.type)) return setState({ status: "error", message: "Wybierz PDF albo zdjęcie (JPG, PNG, HEIC)." });
    if (file.size > MAX_BYTES) return setState({ status: "error", message: "Plik może mieć najwyżej 25 MB." });
    setState({ status: "uploading" });
    const prep = await prepareContractUpload(file.type, file.size).catch((e: Error) => ({ error: e.message }));
    if ("error" in prep) return setState({ status: "error", message: prep.error });
    const { path } = prep;
    const { error } = await createClient().storage.from("contracts").uploadToSignedUrl(path, prep.token, file, { contentType: file.type });
    if (error) return setState({ status: "error", message: `Nie udało się wgrać: ${error.message}` });
    setState({ status: "done", path, name: file.name });
  }

  return (
    <div>
      <span className="label">{label}</span>
      <FileButton label="Wybierz plik umowy" accept="application/pdf,image/*" onFile={onChange} hint="PDF albo zdjęcie" />
      <input type="hidden" name="file_path" value={state.path ?? ""} />
      <input type="hidden" name="file_name" value={state.name ?? ""} />
      {state.status === "uploading" && <p className="mt-1 text-xs text-muted">Wgrywam plik…</p>}
      {state.status === "done" && <p className="mt-1 text-xs text-ok">Plik wgrany: {state.name}</p>}
      {state.status === "error" && <p className="mt-1 text-xs text-bad">{state.message}</p>}
    </div>
  );
}
