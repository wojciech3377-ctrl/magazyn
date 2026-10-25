import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { backupUrl, createContractsArchive, createNewContractsArchive } from "@/lib/backup";
import { errorMessage } from "@/lib/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Kopie zapasowe (administrator): ?plik=baza/... – pobranie istniejącej kopii; ?umowy=YYYY-MM – ZIP plików umów
 * z miesiąca (tworzony w „backups”, potem pobranie). Pobieranie przez link z Supabase – bez limitu wielkości odpowiedzi.
 */
export async function GET(req: NextRequest) {
  await requireAdmin();
  const db = createAdminClient();
  const sp = req.nextUrl.searchParams;
  const back = (msg: string) => NextResponse.redirect(new URL(`/ustawienia?zakladka=kopia&blad=${encodeURIComponent(msg)}`, req.url));
  try {
    let path = sp.get("plik") ?? "";
    if (sp.get("umowy") === "nowe") path = (await createNewContractsArchive(db)).path;
    else if (sp.get("umowy")) path = (await createContractsArchive(db, sp.get("umowy")!)).path;
    const url = await backupUrl(db, path);
    if (!url) return back("Nie ma takiej kopii.");
    return NextResponse.redirect(url);
  } catch (e) {
    return back(errorMessage(e));
  }
}
