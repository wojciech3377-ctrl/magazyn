import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { zipSync } from "fflate";
import { contractPdf } from "./sign";
import { errorMessage } from "@/lib/errors";

function safeName(s: string) {
  return s.replace(/[\\/:*?"<>|#]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 90);
}

/**
 * ZIP z dokumentami umów: wgrane skany i zatwierdzone umowy z szablonu (PDF).
 * prefix = początek nazwy pliku (np. numer zamówienia). Braki trafiają do BRAKUJACE.txt.
 */
export async function contractsZip(db: SupabaseClient, entries: { contractId: string; prefix: string }[], canSeePrices: boolean) {
  const prefixOf = new Map<string, string>();
  for (const e of entries) if (!prefixOf.has(e.contractId)) prefixOf.set(e.contractId, e.prefix);
  if (!prefixOf.size) return null;
  const ids = [...prefixOf.keys()];
  const contracts: Record<string, unknown>[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await db.from("contracts").select("*").in("id", ids.slice(i, i + 200));
    contracts.push(...(data ?? []));
  }
  const files: Record<string, Uint8Array> = {};
  const missing: string[] = [];
  const used = new Set<string>();
  for (const c of contracts as { id: string; counterparty: string | null; number: number | null; doc_number: string | null; file_path: string | null; template: string | null; status: string }[]) {
    const docNo = c.doc_number ?? (c.template && c.number ? String(c.number) : null);
    const base = safeName(`${prefixOf.get(c.id) ?? ""}${prefixOf.get(c.id) ? " - " : ""}${c.counterparty ?? "umowa"}${docNo ? ` - umowa ${docNo}` : ""}`);
    try {
      let bytes: Uint8Array | null = null;
      let ext = "pdf";
      if (c.file_path) {
        const { data: blob, error } = await db.storage.from("contracts").download(c.file_path);
        if (error || !blob) throw error ?? new Error("brak pliku");
        bytes = new Uint8Array(await blob.arrayBuffer());
        ext = (c.file_path.split(".").pop() ?? "pdf").toLowerCase().slice(0, 5);
      } else if (c.template) {
        if (!canSeePrices) {
          missing.push(`${base}: umowa z cenami zakupu – brak dostępu do cen`);
          continue;
        }
        if (c.status !== "accepted") {
          missing.push(`${base}: umowa jeszcze niezatwierdzona`);
          continue;
        }
        bytes = await contractPdf(db, c as never);
      }
      if (!bytes) {
        missing.push(`${base}: brak pliku umowy`);
        continue;
      }
      let name = `${base}.${ext}`;
      for (let i = 2; used.has(name); i++) name = `${base} (${i}).${ext}`;
      used.add(name);
      files[name] = bytes;
    } catch (e) {
      missing.push(`${base}: ${errorMessage(e)}`);
    }
  }
  if (missing.length) files["BRAKUJACE.txt"] = new TextEncoder().encode(`Nie dołączono:\n${missing.join("\n")}\n`);
  if (!Object.keys(files).length) return null;
  return Buffer.from(zipSync(files, { level: 6 }));
}

export function zipResponse(zip: Buffer, name: string) {
  return new Response(new Uint8Array(zip), {
    headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "private, no-store" },
  });
}
