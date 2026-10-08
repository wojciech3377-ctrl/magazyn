import { requireProfile } from "@/lib/auth";
import { dateOnly } from "@/lib/labels";
import { PageHeader } from "@/components/ui";
import { DeliveryForm } from "./DeliveryForm";

export default async function DostawaPage() {
  const { supabase, profile } = await requireProfile();
  const [{ data: stores }, { data: locations }, { data: consignors }, { data: contracts }] = await Promise.all([
    supabase.from("stores").select("id, name").order("name"),
    supabase.from("locations").select("id, name, store_id, base_warehouse_id").eq("active", true).order("name"),
    supabase.from("consignors").select("id, name").order("name"),
    supabase.from("contracts").select("id, counterparty, contract_date").order("created_at", { ascending: false }).limit(300),
  ]);
  return (
    <>
      <PageHeader title="Przyjęcie dostawy" sub="Każda sztuka dostaje osobny kod i etykietę. Stan w Base rośnie o liczbę przyjętych sztuk." />
      <DeliveryForm
        stores={stores ?? []}
        locations={locations ?? []}
        consignors={consignors ?? []}
        contracts={(contracts ?? []).map((c) => ({ id: c.id, label: `${c.counterparty}${c.contract_date ? ` · ${dateOnly(c.contract_date)}` : ""}` }))}
        canSeePrices={profile.can_see_prices}
      />
    </>
  );
}
