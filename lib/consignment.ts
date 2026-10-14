import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Komis: rzeczy komisanta, saldo do wypłaty i zlecenia wysyłki. Dane komisanta czyta wyłącznie serwer
 * (klient z kluczem serwera), zawsze z filtrem po komisancie przypisanym do zalogowanego konta.
 */

export type ConsignorUnit = {
  id: string; code: string; status: string; payout_amount: number | null; received_at: string; sold_at: string | null;
  title: string; option: string; image_url: string | null; has_document: boolean;
};

export type Consignor = {
  id: string; name: string; email: string | null; phone: string | null; bank_account: string | null; notes: string | null; user_id: string | null;
  address_name: string | null; address_street: string | null; address_postcode: string | null; address_city: string | null; address_country: string; address_phone: string | null;
};

export type ConsignorShipment = {
  id: string; status: "requested" | "shipped" | "cancelled"; method: "default" | "custom" | "own_label"; address: ShipAddress | null;
  unit_ids: string[]; label_path: string | null; label_name: string | null; shipping_fee: number | null; invoice_id: string | null;
  tracking: string | null; note: string | null; created_at: string; processed_at: string | null;
};

export type ShipAddress = { name: string; street: string; postcode: string; city: string; country: string; phone: string };

/** Zalogowany komisant (albo przekierowanie: pracownik → aplikacja, brak konta → logowanie). */
/**
 * Zalogowany komisant. Konto z hasłem startowym (pierwsze logowanie albo hasło nadane przez nas) najpierw
 * ustawia własne hasło – wszystkie strony panelu przekierowują na /komis/haslo.
 */
export async function requireConsignor(opts: { passwordPage?: boolean } = {}) {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getClaims();
  const userId = auth?.claims?.sub;
  if (!userId) redirect("/login?next=/komis");
  const db = createAdminClient();
  const { data: consignor } = await db.from("consignors").select("*").eq("user_id", userId).maybeSingle();
  if (!consignor) {
    const { data: profile } = await supabase.from("profiles").select("active").eq("id", userId).maybeSingle();
    redirect(profile?.active ? "/magazyn" : "/login?blad=konto");
  }
  if (!opts.passwordPage && (consignor as { must_change_password?: boolean }).must_change_password) redirect("/komis/haslo");
  return { db, consignor: consignor as Consignor };
}

export async function consignorUnits(db: SupabaseClient, consignorId: string) {
  const { data, error } = await db.rpc("consignor_units", { p_consignor_id: consignorId });
  if (error) throw error;
  return ((data ?? []) as ConsignorUnit[]).map((u) => ({ ...u, payout_amount: u.payout_amount === null ? null : Number(u.payout_amount) }));
}

/** Saldo: kwoty komisanta za rzeczy sprzedane z paragonem / fakturą minus wypłaty. */
export async function consignorBalance(db: SupabaseClient, consignorId: string, units?: ConsignorUnit[]) {
  const [list, { data: payouts }] = await Promise.all([
    units ? Promise.resolve(units) : consignorUnits(db, consignorId),
    db.from("consignor_payouts").select("id, amount, paid_at, note, created_at").eq("consignor_id", consignorId).order("paid_at", { ascending: false }),
  ]);
  return balanceFrom(list, payouts ?? []);
}

/** Saldo z już odczytanych rzeczy i wypłat (bez zapytań). */
export function balanceFrom(list: ConsignorUnit[], payouts: { id: string; amount: number | string; paid_at: string; note: string | null; created_at: string }[]) {
  const earned = list.filter((u) => u.has_document).reduce((s, u) => s + (u.payout_amount ?? 0), 0);
  const paid = payouts.reduce((s, p) => s + Number(p.amount), 0);
  return { earned: round(earned), paid: round(paid), balance: round(earned - paid), payouts: payouts as { id: string; amount: number; paid_at: string; note: string | null; created_at: string }[] };
}

export async function consignmentFee(db: SupabaseClient) {
  const { data } = await db.from("app_settings").select("value").eq("key", "consignment").maybeSingle();
  return Number((data?.value as { shipping_fee?: number } | null)?.shipping_fee ?? 20);
}

export function defaultAddress(c: Consignor): ShipAddress | null {
  if (!c.address_street || !c.address_city || !c.address_postcode) return null;
  return {
    name: c.address_name || c.name, street: c.address_street, postcode: c.address_postcode, city: c.address_city,
    country: c.address_country || "PL", phone: c.address_phone || c.phone || "",
  };
}

const round = (n: number) => Math.round(n * 100) / 100;

export const SHIPMENT_STATUS: Record<string, string> = { requested: "zlecona", shipped: "wysłana", cancelled: "anulowana" };
export const SHIPMENT_METHOD: Record<string, string> = { default: "na adres z konta", custom: "na inny adres (płatna)", own_label: "własna etykieta" };

/** Pierwsze bajty pliku: tylko PDF, JPG, PNG. */
export function labelFileType(buf: Buffer): { ext: string; type: string } | null {
  if (buf.subarray(0, 4).toString("latin1") === "%PDF") return { ext: "pdf", type: "application/pdf" };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: "jpg", type: "image/jpeg" };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: "png", type: "image/png" };
  return null;
}

export type ConsignorContract = {
  id: string; status: string; type: string; template: string | null; source: string | null; paid_at: string | null;
  sign_token: string | null; sign_expires_at: string | null; doc_number: string | null; number: number | null;
};

/** Umowy / faktury przypięte do sprzedanych rzeczy komisanta (unit id → umowa). */
export async function consignorContracts(db: SupabaseClient, consignorId: string, unitIds: string[]) {
  const out = new Map<string, ConsignorContract>();
  for (let i = 0; i < unitIds.length; i += 200) {
    const { data } = await db.from("units")
      .select("id, contract:contracts(id, status, type, template, source, paid_at, sign_token, sign_expires_at, doc_number, number)")
      .in("id", unitIds.slice(i, i + 200)).eq("consignor_id", consignorId).not("contract_id", "is", null);
    for (const u of data ?? []) if (u.contract) out.set(u.id as string, u.contract as unknown as ConsignorContract);
  }
  return out;
}
