"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

const ALLOWED = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
const MAX_BYTES = 25 * 1024 * 1024; // limit bucketu ustawiony w migracji

/**
 * Plik umowy wgrywany z przeglądarki prosto do Supabase Storage (bez limitu rozmiaru zapytania
 * na Vercel). Do formularza trafia tylko ścieżka pliku.
 */
export function ContractFileInput({ label = "Plik umowy (PDF lub zdjęcie)" }: { label?: string }) {
  const [state, setState] = useState<{ path?: string; name?: string; status: "idle" | "uploading" | "done" | "error"; message?: string }>({ status: "idle" });

  async function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return setState({ status: "idle" });
    if (!ALLOWED.includes(file.type)) return setState({ status: "error", message: "Wybierz PDF albo zdjęcie (JPG, PNG, HEIC)." });
    if (file.size > MAX_BYTES) return setState({ status: "error", message: "Plik może mieć najwyżej 25 MB." });
    setState({ status: "uploading" });
    const ext = (file.name.split(".").pop() ?? "bin").toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
    const now = new Date();
    const path = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${crypto.randomUUID()}.${ext}`;
    const { error } = await createClient().storage.from("contracts").upload(path, file, { contentType: file.type, upsert: false });
    if (error) return setState({ status: "error", message: `Nie udało się wgrać: ${error.message}` });
    setState({ status: "done", path, name: file.name });
  }

  return (
    <div>
      <label className="label">{label}</label>
      <input className="input" type="file" accept="application/pdf,image/*" onChange={onChange} aria-label={label} />
      <input type="hidden" name="file_path" value={state.path ?? ""} />
      <input type="hidden" name="file_name" value={state.name ?? ""} />
      {state.status === "uploading" && <p className="mt-1 text-xs text-muted">Wgrywam plik…</p>}
      {state.status === "done" && <p className="mt-1 text-xs text-ok">Plik wgrany: {state.name}</p>}
      {state.status === "error" && <p className="mt-1 text-xs text-bad">{state.message}</p>}
    </div>
  );
}
