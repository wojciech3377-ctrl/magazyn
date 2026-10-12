import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { PosForm } from "./PosForm";
import { createAdminClient } from "@/lib/supabase/admin";
import { fiscalPrinterReady, getFiscalSettings, PTU_LETTERS, ptuLabel } from "@/lib/fiscal/jobs";

export default async function KasaPage() {
  const { supabase } = await requireProfile();
  const db = createAdminClient();
  const [{ data: stores }, printer, fiscal] = await Promise.all([
    supabase.from("stores").select("id, name").order("name"),
    fiscalPrinterReady(db),
    getFiscalSettings(db),
  ]);
  const ptu = PTU_LETTERS.map((l) => ({ letter: l, label: ptuLabel(fiscal, l) }));
  return (
    <>
      <PageHeader title="Kasa – sprzedaż stacjonarna" sub="Skaner kodów działa jak klawiatura: kliknij w pole i skanuj etykiety po kolei. Możesz też wpisać nazwę produktu." actions={<><Link className="btn-secondary" href="/katalog?widok=wlasne">Własne produkty</Link><Link className="btn-secondary" href="/sprzedaz?widok=stacjonarna">Historia sprzedaży</Link></>} />
      <PosForm stores={stores ?? []} printer={printer} ptu={ptu} defaultPtu={fiscal.ptu23} />
    </>
  );
}
