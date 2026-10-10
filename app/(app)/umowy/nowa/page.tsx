import { requireProfile } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { ContractForm } from "../ContractForm";

export default async function NewContractPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const { supabase, profile } = await requireProfile();
  const { data: consignors } = await supabase.from("consignors").select("id, name").order("name");
  // Sztuki zaznaczone w Magazynie (ids) albo podane kodem (sztuki).
  const ids = ([] as string[]).concat(sp.ids ?? []).flatMap((x) => x.split(",")).filter((x) => /^[0-9a-f-]{36}$/.test(x)).slice(0, 300);
  const { data: picked } = ids.length ? await supabase.from("units").select("code").in("id", ids) : { data: [] };
  const codes = [...new Set([...String(sp.sztuki ?? "").split(/[\s,]+/).filter(Boolean), ...(picked ?? []).map((u) => u.code as string)])];
  const back = typeof sp.wroc === "string" && sp.wroc.startsWith("/") && !sp.wroc.startsWith("//") ? sp.wroc : "";
  // Umowa do sprzedanego przedmiotu bez sztuki w magazynie (?sprzedaz=).
  const saleId = typeof sp.sprzedaz === "string" && /^[0-9a-f-]{36}$/.test(sp.sprzedaz) ? sp.sprzedaz : null;
  const { data: sale } = saleId
    ? await supabase.from("sales").select("id, order_ref, unit_id, store_id, variant_id, variant:variants(option, product:products(title))").eq("id", saleId).maybeSingle()
    : { data: null };
  const v = sale?.variant as unknown as { option: string; product: { title: string } } | null;
  const saleLabel = sale && !sale.unit_id ? `${v ? `${v.product.title} ${v.option}` : "przedmiot"}${sale.order_ref ? ` (zamówienie ${sale.order_ref})` : ""}` : null;
  return (
    <>
      <PageHeader title="Nowa umowa" sub="Plik trafia do prywatnego magazynu plików; widzą go tylko zalogowani pracownicy." />
      <ContractForm consignors={consignors ?? []} defaultUnits={codes.join(" ")} canSeePrices={profile.can_see_prices} returnTo={back} saleId={saleLabel ? saleId : null} saleLabel={saleLabel}
        pickVariantStore={sale && !sale.unit_id && !sale.variant_id ? (sale.store_id as string | null) ?? "" : null} />
    </>
  );
}
