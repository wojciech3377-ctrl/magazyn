import type { SupabaseClient } from "@supabase/supabase-js";

/** Nadawca na etykietach (Ustawienia → Wysyłka). */
export type Sender = {
  company: string;
  name: string;
  street: string;
  postcode: string;
  city: string;
  email: string;
  phone: string;
  inpost_send_point: string; // any_apm = dowolny paczkomat albo kod, np. POZ11H
  cod_iban: string;
};

export const DEFAULT_SENDER: Sender = {
  company: "SNEAKERS DEPOT SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ",
  name: "",
  street: "Długa 13",
  postcode: "61-850",
  city: "Poznań",
  email: "sneakersdepot.pl@gmail.com",
  phone: "+48503169256",
  inpost_send_point: "any_apm",
  cod_iban: "",
};

export async function getSender(db: SupabaseClient): Promise<Sender> {
  const { data } = await db.from("app_settings").select("value").eq("key", "shipping_sender").maybeSingle();
  return { ...DEFAULT_SENDER, ...((data?.value as Partial<Sender>) ?? {}) };
}

/** Gabaryty paczkomatu InPost (cm): A, B, C. */
export const LOCKER_SIZES = {
  A: { height: 8, width: 38, depth: 64, label: "A – mała (8 × 38 × 64 cm)" },
  B: { height: 19, width: 38, depth: 64, label: "B – średnia (19 × 38 × 64 cm)" },
  C: { height: 41, width: 38, depth: 64, label: "C – duża (41 × 38 × 64 cm)" },
} as const;

export const SERVICE_LABEL = {
  inpost_locker: "InPost Paczkomat",
  inpost_courier: "InPost Kurier",
  dpd: "DPD Kurier",
} as const;
export type ServiceKey = keyof typeof SERVICE_LABEL;
