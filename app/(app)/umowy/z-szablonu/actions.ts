"use server";

import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { getCompany } from "@/lib/contracts/settings";
import { contractTotal } from "@/lib/contracts/purchase";

type Line = { unit_id?: string; variant_id?: string; title: string; option: string; identifier?: string | null; qty: number; price: string };

export async function createLinkContract(_: unknown, formData: FormData): Promise<{ error?: string }> {
  const { supabase } = await requireProfile();
  const lines = JSON.parse(String(formData.get("lines") ?? "[]")) as Line[];
  if (!lines.length) return { error: "Dodaj co najmniej jedną rzecz." };
  const items = [];
  for (const l of lines) {
    const price = Number(String(l.price).replace(/\s/g, "").replace(",", "."));
    if (!Number.isFinite(price) || price <= 0) return { error: `Podaj cenę dla: ${l.title} ${l.option}` };
    items.push({ unit_id: l.unit_id || undefined, variant_id: l.variant_id || undefined, title: l.title, option: l.option, identifier: l.identifier ?? null, qty: Math.max(1, Math.floor(l.qty || 1)), price: Math.round(price * 100) / 100 });
  }
  const hasNew = items.some((i) => !i.unit_id);
  const locationId = String(formData.get("location_id") ?? "") || null;
  if (hasNew && !locationId) return { error: "Wybierz lokalizację, do której przyjdzie towar." };
  const company = await getCompany(supabase);
  const days = Math.min(60, Math.max(0, Number(formData.get("payment_days") ?? company.payment_days ?? 7) || 7));
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");

  const { data: c, error } = await supabase.from("contracts").insert({
    type: "purchase",
    template: "purchase_v1",
    source: "link",
    status: "sent",
    counterparty: "(czeka na podpis)",
    amount: contractTotal(items),
    payment_days: days,
    items,
    sale_id: String(formData.get("sale_id") ?? "") || null,
    location_id: locationId,
    seller_email: String(formData.get("seller_email") ?? "").trim() || null,
    seller_phone: String(formData.get("seller_phone") ?? "").trim() || null,
    sign_token: token,
    sign_expires_at: new Date(Date.now() + 14 * 86400_000).toISOString(),
    notes: String(formData.get("notes") ?? "").trim() || null,
  }).select("id").single();
  if (error) return { error: error.message };

  // Sztuki już na stanie od razu wskazują umowę (czeka na podpis).
  const unitIds = items.map((i) => i.unit_id).filter(Boolean) as string[];
  if (unitIds.length) await supabase.from("units").update({ contract_id: c.id }).in("id", unitIds);

  redirect(`/umowy/${c.id}?ok=${encodeURIComponent("Umowa gotowa – wyślij sprzedającemu link do podpisu.")}`);
}
