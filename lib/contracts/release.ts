import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Sprzedaż poza JPK (paragon PDF bez fiskalnego, wysyłka z paragonu PAR) nie zużywa umowy: umowy sprzedanych sztuk
 * wracają do niewykorzystanych (Umowy → „Bez rzeczy”), a w historii sztuki zostaje wpis, z której umowy ją odpięto.
 */
export async function releaseContracts(db: SupabaseClient, unitIds: string[], note: string) {
  if (!unitIds.length) return 0;
  const { data } = await db.from("units").select("id, contract_id").in("id", unitIds).not("contract_id", "is", null);
  const withContract = (data ?? []) as { id: string; contract_id: string }[];
  if (!withContract.length) return 0;
  await db.from("units").update({ contract_id: null }).in("id", withContract.map((u) => u.id));
  await db.from("unit_events").insert(withContract.map((u) => ({ unit_id: u.id, type: "contract", data: { detached: u.contract_id, note } })));
  return withContract.length;
}
