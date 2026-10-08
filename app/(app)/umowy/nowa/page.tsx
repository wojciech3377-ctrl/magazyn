import { requireProfile } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { ContractForm } from "../ContractForm";

export default async function NewContractPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const { supabase, profile } = await requireProfile();
  const { data: consignors } = await supabase.from("consignors").select("id, name").order("name");
  // Sztuki zaznaczone w Magazynie (ids) albo podane kodem (sztuki).
  const ids = ([] as string[]).concat(sp.ids ?? []).filter((x) => /^[0-9a-f-]{36}$/.test(x)).slice(0, 300);
  const { data: picked } = ids.length ? await supabase.from("units").select("code").in("id", ids) : { data: [] };
  const codes = [...new Set([...String(sp.sztuki ?? "").split(/[\s,]+/).filter(Boolean), ...(picked ?? []).map((u) => u.code as string)])];
  const back = typeof sp.wroc === "string" && sp.wroc.startsWith("/") && !sp.wroc.startsWith("//") ? sp.wroc : "";
  return (
    <>
      <PageHeader title="Nowa umowa" sub="Plik trafia do prywatnego magazynu plików; widzą go tylko zalogowani pracownicy." />
      <ContractForm consignors={consignors ?? []} defaultUnits={codes.join(" ")} canSeePrices={profile.can_see_prices} returnTo={back} />
    </>
  );
}
