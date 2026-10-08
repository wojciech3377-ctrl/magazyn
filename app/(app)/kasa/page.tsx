import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { PosForm } from "./PosForm";

export default async function KasaPage() {
  const { supabase } = await requireProfile();
  const { data: stores } = await supabase.from("stores").select("id, name").order("name");
  return (
    <>
      <PageHeader title="Kasa – sprzedaż stacjonarna" sub="Skaner kodów działa jak klawiatura: kliknij w pole skanu i skanuj etykiety po kolei." actions={<Link className="btn-secondary" href="/sprzedaz?widok=stacjonarna">Historia sprzedaży</Link>} />
      <PosForm stores={stores ?? []} />
    </>
  );
}
