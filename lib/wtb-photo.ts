import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/** Własne zdjęcia WTB: prywatny kosz „wtb-photos”, w bazie jako „wtb:<ścieżka>”. */
const BUCKET = "wtb-photos";
const PREFIX = "wtb:";
const PATH = /^\d{4}\/\d{2}\/[0-9a-f-]{36}\.jpg$/;
export const WTB_PHOTO_MAX = 1_800_000;

export const isWtbPhoto = (u: string | null | undefined): boolean => !!u && u.startsWith(PREFIX) && PATH.test(u.slice(PREFIX.length));
const pathOf = (u: string) => u.slice(PREFIX.length);

/** Zapis zdjęcia (JPEG zmniejszony w przeglądarce). Zwraca wartość do kolumny image_url. */
export async function storeWtbPhoto(file: File): Promise<string> {
  if (!(file instanceof File) || !file.size) throw new Error("Wybierz zdjęcie.");
  if (file.size > WTB_PHOTO_MAX) throw new Error("Zdjęcie jest za duże (maks. 1,8 MB po zmniejszeniu).");
  const buf = Buffer.from(await file.arrayBuffer());
  // Tylko prawdziwy JPEG (nagłówek FF D8 FF) – przeglądarka zamienia każde zdjęcie na JPEG przed wysłaniem.
  if (!(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) throw new Error("Nieobsługiwany format zdjęcia – wybierz JPG, PNG albo zdjęcie z aparatu.");
  const now = new Date();
  const path = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${crypto.randomUUID()}.jpg`;
  const { error } = await createAdminClient().storage.from(BUCKET).upload(path, buf, { contentType: "image/jpeg", upsert: false });
  if (error) throw new Error(`Nie udało się zapisać zdjęcia: ${error.message}`);
  return PREFIX + path;
}

/** Usuwa pliki, do których nie odwołuje się już żadna pozycja WTB. */
export async function dropUnusedWtbPhotos(values: (string | null | undefined)[]) {
  const candidates = [...new Set(values.filter((v): v is string => isWtbPhoto(v)))];
  if (!candidates.length) return;
  const db = createAdminClient();
  const { data } = await db.from("wtb_items").select("image_url").in("image_url", candidates);
  const used = new Set((data ?? []).map((r) => r.image_url as string));
  const gone = candidates.filter((c) => !used.has(c)).map(pathOf);
  if (gone.length) await db.storage.from(BUCKET).remove(gone);
}

/** Adresy do wyświetlenia na stronie: zdjęcia z kosza jako podpisane linki (1 h), z Shopify w zadanej szerokości. */
export async function wtbDisplayUrls(values: (string | null | undefined)[], width: number): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const own = [...new Set(values.filter((v): v is string => isWtbPhoto(v)))];
  for (const v of values) if (v && !isWtbPhoto(v) && /^https:\/\//.test(v)) out.set(v, `${v}${v.includes("?") ? "&" : "?"}width=${width}`);
  if (own.length) {
    const { data } = await createAdminClient().storage.from(BUCKET).createSignedUrls(own.map(pathOf), 3600);
    (data ?? []).forEach((d, i) => { if (d.signedUrl) out.set(own[i], d.signedUrl); });
  }
  return out;
}

/** Zdjęcie z kosza jako data URL (do grafiki WTB). */
export async function wtbPhotoData(value: string): Promise<string | null> {
  if (!isWtbPhoto(value)) return null;
  try {
    const { data } = await createAdminClient().storage.from(BUCKET).download(pathOf(value));
    return data ? `data:image/jpeg;base64,${Buffer.from(await data.arrayBuffer()).toString("base64")}` : null;
  } catch {
    return null;
  }
}
