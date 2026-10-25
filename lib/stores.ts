/**
 * Sklepy bez sklepów-kopii (SQL 78, np. Owca Store) – do wyboru sklepu przy magazynie, dostawie, kasie, lokalizacjach.
 * Kopia nie ma własnych lokalizacji ani sztuk (sprzedaje sztuki sklepu źródłowego).
 */
export function withoutMirrors<R extends { data: unknown[] | null }>(r: R): R {
  return { ...r, data: (r.data ?? []).filter((s) => !(s as { mirror_of?: string | null }).mirror_of) };
}
