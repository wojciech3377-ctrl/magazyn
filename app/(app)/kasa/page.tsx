import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { PosForm } from "./PosForm";
import { createAdminClient } from "@/lib/supabase/admin";
import { fiscalPrinterReady, getFiscalSettings, PTU_LETTERS, ptuLabel } from "@/lib/fiscal/jobs";
import { withoutMirrors } from "@/lib/stores";

export default async function KasaPage() {
  const { supabase } = await requireProfile();
  const db = createAdminClient();
  const [{ data: stores }, printer, fiscal] = await Promise.all([
    supabase.from("stores").select("*").order("name").then(withoutMirrors),
    fiscalPrinterReady(db),
    getFiscalSettings(db),
  ]);
  const ptu = PTU_LETTERS.map((l) => ({ letter: l, label: ptuLabel(fiscal, l) }));
  // Program drukarki co minutę zgłasza stan – dłużej niż 3 minuty cisza = komputer przy drukarce wyłączony albo program zamknięty.
  const { data: seen } = await db.from("fiscal_printers").select("last_seen_at").eq("active", true).order("last_seen_at", { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
  const printerOnline = !!seen?.last_seen_at && Date.now() - new Date(seen.last_seen_at as string).getTime() < 3 * 60_000;
  return (
    <>
      <PageHeader title="Kasa – sprzedaż stacjonarna" sub="Skaner kodów działa jak klawiatura: kliknij w pole i skanuj etykiety po kolei. Możesz też wpisać nazwę produktu." actions={<><Link className="btn-secondary" href="/katalog?widok=wlasne">Własne produkty</Link><Link className="btn-secondary" href="/sprzedaz?widok=stacjonarna">Historia sprzedaży</Link></>} />
      <PosForm stores={stores ?? []} printer={printer} printerOnline={printerOnline} ptu={ptu} defaultPtu={fiscal.ptuMargin} ptuFor={{ vat23: fiscal.ptu23, margin: fiscal.ptuMargin }} />
    </>
  );
}
