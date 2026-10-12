import { requireProfile } from "@/lib/auth";
import { dateOnly } from "@/lib/labels";
import Link from "next/link";
import { Notice, PageHeader } from "@/components/ui";
import { AcceptTab, loadIntakeCounts, TransitTab } from "./IntakeTabs";
import { DeliveryForm } from "./DeliveryForm";

export default async function DostawaPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const tab = sp.zakladka === "akceptacja" ? "akceptacja" : sp.zakladka === "w-drodze" ? "w-drodze" : "nowa";
  const { supabase, profile } = await requireProfile();
  const counts = await loadIntakeCounts();
  const tabs = (
    <nav className="mb-4 flex flex-wrap gap-1 border-b border-line text-sm" aria-label="Przyjęcie dostawy">
      {([["nowa", "Nowa dostawa", 0], ["akceptacja", "Do akceptacji", counts.accept], ["w-drodze", "W drodze", counts.transit]] as const).map(([k, label, n]) => (
        <Link key={k} href={k === "nowa" ? "/dostawa" : `/dostawa?zakladka=${k}`} className={`-mb-px border-b-2 px-3 py-2 ${tab === k ? "border-accent font-medium text-ink" : "border-transparent text-muted hover:text-ink"}`}>
          {label}{n > 0 && <span className={`ml-1 rounded px-1.5 py-0.5 text-xs tabular-nums ${k === "akceptacja" ? "bg-emerald-600 text-white" : "bg-orange-500 text-white"}`}>{n}</span>}
        </Link>
      ))}
    </nav>
  );
  const flash = sp.ok || sp.blad ? <div className="mb-4"><Notice tone={sp.blad ? "error" : "ok"}>{sp.blad ?? sp.ok}</Notice></div> : null;
  if (tab !== "nowa") {
    return (
      <>
        <PageHeader title="Przyjęcie dostawy" sub={tab === "akceptacja" ? "Zgłoszenia komisantów i podpisane umowy: Tak / Nie / Oferta z Twoją kwotą." : "Paczki od komisantów i towar z umów – po dotarciu przyjmij je do magazynu."} />
        {tabs}
        {flash}
        {tab === "akceptacja" ? <AcceptTab /> : <TransitTab />}
      </>
    );
  }
  const [{ data: stores }, { data: locations }, { data: consignors }, { data: contracts }] = await Promise.all([
    supabase.from("stores").select("id, name").order("name"),
    supabase.from("locations").select("id, name, store_id, base_warehouse_id").eq("active", true).order("name"),
    supabase.from("consignors").select("id, name").order("name"),
    supabase.from("contracts").select("id, counterparty, contract_date").order("created_at", { ascending: false }).limit(300),
  ]);
  return (
    <>
      <PageHeader title="Przyjęcie dostawy" sub="Każda sztuka dostaje osobny kod i etykietę. Stan w Shopify rośnie o liczbę przyjętych sztuk." />
      {tabs}
      {flash}
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
