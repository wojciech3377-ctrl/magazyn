"use server";

import { requireProfile } from "@/lib/auth";

export type InvLine = { unitId: string | null; code: string | null; title: string; option: string; status?: string; note?: string };
export type InvSummary = { expected: number; scanned: number; matched: number; missing: InvLine[]; extra: (InvLine & { scan: string })[]; reportId: string | null } | { error: string };

const PRESENT = ["in_stock", "reserved", "consignor_hold", "returned"];

/**
 * Podsumowanie inwentaryzacji lokalizacji: zeskanowane kody (kod sztuki, IMEI, SKU, EAN)
 * porównane ze sztukami, które według aplikacji leżą w tej lokalizacji.
 */
export async function summarizeInventory(locationId: string, scans: string[]): Promise<InvSummary> {
  const { supabase } = await requireProfile();
  if (!/^[0-9a-f-]{36}$/.test(locationId)) return { error: "Wybierz lokalizację." };
  const codes = scans.map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 5000);
  const { data: expectedRows } = await supabase.from("units_list").select("id, code, identifier, title, option, status, variant_id")
    .eq("location_id", locationId).in("status", PRESENT).limit(10000);
  type U = { id: string; code: string; identifier: string | null; title: string; option: string; status: string; variant_id: string };
  const expected = (expectedRows ?? []) as U[];
  const left = new Map(expected.map((u) => [u.id, u]));
  const byCode = new Map<string, U>();
  for (const u of expected) { byCode.set(u.code.toUpperCase(), u); if (u.identifier) byCode.set(u.identifier.toUpperCase(), u); }

  // Kody, które nie są kodem sztuki z tej lokalizacji: sztuka z innego miejsca albo SKU / EAN rozmiaru.
  const unknown = [...new Set(codes.filter((c) => !byCode.has(c)))];
  const otherUnits = new Map<string, { id: string; code: string; title: string; option: string; status: string; location_name: string }>();
  const variantOfCode = new Map<string, string[]>();
  for (let i = 0; i < unknown.length; i += 150) {
    const part = unknown.slice(i, i + 150);
    const list = part.map((c) => `"${c.replace(/"/g, "")}"`).join(",");
    const [{ data: us }, { data: links }, { data: eans }] = await Promise.all([
      supabase.from("units_list").select("id, code, identifier, title, option, status, location_name").or(`code.in.(${list}),identifier.in.(${list})`),
      supabase.from("variant_store_links").select("variant_id, base_sku, sku").or(`base_sku.in.(${list}),sku.in.(${list})`),
      supabase.from("variants").select("id, ean").in("ean", part),
    ]);
    for (const u of us ?? []) { otherUnits.set(String(u.code).toUpperCase(), u as never); if (u.identifier) otherUnits.set(String(u.identifier).toUpperCase(), u as never); }
    for (const l of links ?? []) for (const k of [l.base_sku, l.sku]) if (k) variantOfCode.set(String(k).toUpperCase(), [...new Set([...(variantOfCode.get(String(k).toUpperCase()) ?? []), l.variant_id as string])]);
    for (const v of eans ?? []) variantOfCode.set(String(v.ean).toUpperCase(), [...new Set([...(variantOfCode.get(String(v.ean).toUpperCase()) ?? []), v.id as string])]);
  }

  const extra: (InvLine & { scan: string })[] = [];
  let matched = 0;
  // 1. Dokładne sztuki.
  for (const c of codes) {
    const u = byCode.get(c);
    if (!u) continue;
    if (left.has(u.id)) { left.delete(u.id); matched++; }
    else extra.push({ scan: c, unitId: u.id, code: u.code, title: u.title, option: u.option, note: "zeskanowana drugi raz" });
  }
  // 2. SKU / EAN rozmiaru – najstarsza niezeskanowana sztuka tego rozmiaru.
  for (const c of codes) {
    if (byCode.has(c)) continue;
    const other = otherUnits.get(c);
    if (other) { extra.push({ scan: c, unitId: other.id, code: other.code, title: other.title, option: other.option, status: other.status, note: `w aplikacji: ${other.location_name}` }); continue; }
    const vids = variantOfCode.get(c);
    if (!vids?.length) { extra.push({ scan: c, unitId: null, code: null, title: "nieznany kod", option: "" }); continue; }
    const hit = [...left.values()].find((u) => vids.includes(u.variant_id));
    if (hit) { left.delete(hit.id); matched++; continue; }
    extra.push({ scan: c, unitId: null, code: null, title: "rozmiar ponad stan w aplikacji", option: "", note: "więcej sztuk niż w aplikacji" });
  }
  const missing = [...left.values()].map((u) => ({ unitId: u.id, code: u.code, title: u.title, option: u.option, status: u.status }));
  const { data: rep } = await supabase.from("inventory_reports").insert({
    location_id: locationId, scanned: codes.length, expected: expected.length, missing, extra,
  }).select("id").single();
  return { expected: expected.length, scanned: codes.length, matched, missing, extra, reportId: (rep?.id as string) ?? null };
}
