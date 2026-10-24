import "server-only";
import { PURCHASE_FORM } from "@/lib/labels";
import type { SupabaseClient } from "@supabase/supabase-js";

export type HistoryItem = { at: string; who: string | null; text: string; contractId: string; label: string | null; filePath?: string | null; deleted?: boolean };

const STATUS: Record<string, string> = { sent: "wysłana do podpisu", signed: "podpisana", accepted: "zatwierdzona", rejected: "odrzucona", cancelled: "anulowana", offer: "oferta cenowa" };
const NAMES: Record<string, string> = {
  counterparty: "kontrahent", seller_name: "sprzedający", seller_id_number: "PESEL / NIP", seller_address: "adres", seller_email: "e-mail",
  seller_phone: "telefon", seller_bank_account: "konto", payment_method: "forma zapłaty", payment_days: "termin zapłaty", amount: "kwota",
  amount_per_item: "kwota za rzecz", currency: "waluta", doc_number: "numer", vat_form: "forma VAT", contract_date: "data", file_name: "plik",
  items: "pozycje", notes: "notatka", paid_at: "opłacona", sign_expires_at: "ważność linku", consignor_id: "komisant", location_id: "lokalizacja",
  sale_id: "sprzedaż", offer: "oferta", type: "typ",
};
const SKIP = new Set(["file_path", "signed_at", "accepted_at", "units_created_at", "group_id"]);

function val(v: unknown): string {
  if (v === null || v === undefined || v === "") return "–";
  if (Array.isArray(v)) return `${v.length} poz.`;
  if (typeof v === "object") return "zmienione";
  if (v === true || v === "true") return "tak";
  if (v === false || v === "false") return "nie";
  const s = String(v);
  if (PURCHASE_FORM[s]) return PURCHASE_FORM[s];
  return /^\d{4}-\d{2}-\d{2}T/.test(s) ? s.slice(0, 10) : s.slice(0, 60);
}

/** Opis zmiany umowy po polsku. */
const PRICE_KEYS = new Set(["amount", "offer"]);

function describe(kind: string, ch: Record<string, unknown>, canSeePrices = true): string {
  if (kind === "created") return `utworzona${ch.status ? ` (${STATUS[String(ch.status)] ?? ch.status})` : ""}${ch.file_name ? ` · plik ${ch.file_name}` : ""}`;
  if (kind === "deleted") return "usunięta z aplikacji (plik zachowany)";
  const parts: string[] = [];
  for (const [k, pair] of Object.entries(ch)) {
    const [a, b] = pair as [unknown, unknown];
    if (k === "status") parts.push(`status: ${STATUS[String(a)] ?? a} → ${STATUS[String(b)] ?? b}`);
    else if (k === "paid_at") parts.push(b ? "oznaczona jako opłacona" : "cofnięto opłacenie");
    else if (k === "file_path" && !ch.file_name) parts.push(b ? "nowy plik" : "plik usunięty");
    else if (SKIP.has(k)) continue;
    else if (!canSeePrices && PRICE_KEYS.has(k)) parts.push(`${NAMES[k] ?? k}: zmieniona`);
    else parts.push(`${NAMES[k] ?? k}: ${val(a)} → ${val(b)}`);
  }
  return parts.join(" · ") || "zmiana";
}

/** Historia umów: zmiany samej umowy (SQL 73) i przypięcia / odpięcia rzeczy (historia sztuk). */
export async function contractHistory(db: SupabaseClient, opts: { contractId?: string; limit?: number; search?: string; canSeePrices?: boolean } = {}): Promise<HistoryItem[]> {
  const limit = opts.limit ?? 200;
  let q = db.from("contract_events").select("contract_id, label, kind, changes, actor, created_at").order("created_at", { ascending: false }).limit(limit);
  if (opts.contractId) q = q.eq("contract_id", opts.contractId);
  if (opts.search) q = q.ilike("label", `%${opts.search.replace(/[%_,()]/g, " ").trim()}%`);
  const { data: ev } = await q;
  const unitQ = opts.contractId
    ? db.from("unit_events").select("unit_id, data, created_at, created_by, unit:units(code)").eq("type", "contract")
        .or(`data->>contract_id.eq.${opts.contractId},data->>detached.eq.${opts.contractId},data->>detached_from.eq.${opts.contractId}`).order("created_at", { ascending: false }).limit(200)
    : null;
  const { data: ue } = unitQ ? await unitQ.then((r) => r, () => ({ data: null })) : { data: null };
  const actors = [...new Set([...(ev ?? []).map((e) => e.actor), ...((ue ?? []) as { created_by?: string | null }[]).map((u) => u.created_by)].filter(Boolean))] as string[];
  const { data: people } = actors.length ? await db.from("profiles").select("id, full_name, email").in("id", actors) : { data: [] };
  const who = (id: string | null | undefined) => {
    if (!id) return null;
    const p = (people ?? []).find((x) => x.id === id);
    return (p?.full_name as string | null) || (p?.email as string | null) || null;
  };
  const out: HistoryItem[] = (ev ?? []).map((e) => {
    const ch = (e.changes ?? {}) as Record<string, unknown>;
    return {
      at: e.created_at as string, who: who(e.actor as string | null) ?? (e.actor ? null : "automat / sprzedający"),
      text: describe(e.kind as string, ch, opts.canSeePrices ?? false), contractId: e.contract_id as string, label: e.label as string | null,
      filePath: e.kind === "deleted" ? (ch.file_path as string | null) ?? null : null, deleted: e.kind === "deleted",
    };
  });
  for (const u of (ue ?? []) as unknown as { data: Record<string, unknown>; created_at: string; created_by?: string | null; unit: { code: string } | null }[]) {
    const attached = u.data.contract_id === opts.contractId;
    out.push({
      at: u.created_at, who: who(u.created_by), contractId: opts.contractId!, label: null,
      text: `${attached ? "przypięta rzecz" : "odpięta rzecz"} ${u.unit?.code ?? ""}${u.data.note ? ` – ${u.data.note}` : ""}`.trim(),
    });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}
