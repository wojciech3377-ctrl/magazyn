import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Numer umowy z treści dokumentu, np. „NR00512”, „Umowa nr 190/2026”. */
export function findContractNumber(text: string): string | null {
  const t = text.replace(/\s+/g, " ");
  const nr = t.match(/\bNR\s?(\d{3,7})\b/);
  if (nr) return `NR${nr[1]}`;
  const umowa = t.match(/umow[aęy](?:\s+\S+){0,4}?\s+nr\.?\s*:?\s*([A-Z0-9][A-Z0-9/\-]{1,24})/i);
  if (umowa) return umowa[1];
  const numer = t.match(/numer\s+umowy\s*:?\s*([A-Z0-9][A-Z0-9/\-]{1,24})/i);
  return numer?.[1] ?? null;
}

/** Odczyt numeru z PDF umowy w Storage (skany-zdjęcia bez tekstu → null). */
export async function detectContractNumber(db: SupabaseClient, filePath: string | null) {
  if (!filePath || !/\.pdf$/i.test(filePath)) return null;
  try {
    const { data } = await db.storage.from("contracts").download(filePath);
    if (!data) return null;
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(await data.arrayBuffer()));
    const { text } = await extractText(pdf, { mergePages: true });
    return findContractNumber(Array.isArray(text) ? text.join(" ") : text);
  } catch {
    return null;
  }
}

/** Uzupełnia numer umowy z pliku, jeśli jeszcze go nie ma. */
export async function fillContractNumber(db: SupabaseClient, contractId: string) {
  const { data: c } = await db.from("contracts").select("id, file_path, doc_number, template").eq("id", contractId).maybeSingle();
  if (!c || c.doc_number || c.template) return null;
  const nr = await detectContractNumber(db, c.file_path);
  if (nr) await db.from("contracts").update({ doc_number: nr }).eq("id", c.id);
  return nr;
}

/** Zadanie cykliczne: numery dla wgranych wcześniej skanów PDF (po kilkadziesiąt na raz). */
export async function backfillContractNumbers(db: SupabaseClient, limit = 25) {
  const { data: st } = await db.from("sync_state").select("value").eq("key", "contract_numbers").maybeSingle();
  const after = (st?.value as { after?: string } | null)?.after ?? "1970-01-01T00:00:00Z";
  const { data: rows } = await db.from("contracts").select("id, created_at").is("doc_number", null).is("template", null)
    .not("file_path", "is", null).gt("created_at", after).order("created_at").limit(limit);
  let found = 0;
  for (const r of rows ?? []) if (await fillContractNumber(db, r.id)) found++;
  const last = rows?.at(-1)?.created_at;
  if (last) await db.from("sync_state").upsert({ key: "contract_numbers", value: { after: last }, updated_at: new Date().toISOString() });
  return { checked: rows?.length ?? 0, found };
}
