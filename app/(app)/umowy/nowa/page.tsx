import { requireProfile } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { ContractForm } from "../ContractForm";

export default async function NewContractPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { supabase, profile } = await requireProfile();
  const { data: consignors } = await supabase.from("consignors").select("id, name").order("name");
  return (
    <>
      <PageHeader title="Nowa umowa" sub="Plik trafia do prywatnego magazynu plików; widzą go tylko zalogowani pracownicy." />
      <ContractForm consignors={consignors ?? []} defaultUnits={sp.sztuki ?? ""} canSeePrices={profile.can_see_prices} />
    </>
  );
}
