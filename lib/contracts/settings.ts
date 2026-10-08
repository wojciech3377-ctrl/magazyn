import type { SupabaseClient } from "@supabase/supabase-js";
import type { Company } from "./purchase";

export const DEFAULT_COMPANY: Company = {
  name: "SNEAKERS DEPOT SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ",
  street: "Długa 13",
  city: "61-850 Poznań",
  nip: "6060120685",
  email: "sneakersdepot.pl@gmail.com",
  payment_days: 7,
};

export async function getCompany(db: SupabaseClient): Promise<Company> {
  const { data } = await db.from("app_settings").select("value").eq("key", "company").maybeSingle();
  return { ...DEFAULT_COMPANY, ...((data?.value as Partial<Company>) ?? {}) };
}

/** Podpis kupującego (firmy) rysowany raz w Ustawieniach, wstawiany do każdej umowy. */
export async function getBuyerSignature(db: SupabaseClient): Promise<string | null> {
  const { data } = await db.from("app_settings").select("value").eq("key", "buyer_signature").maybeSingle();
  const v = data?.value as { image?: string } | null;
  return v?.image ?? null;
}
