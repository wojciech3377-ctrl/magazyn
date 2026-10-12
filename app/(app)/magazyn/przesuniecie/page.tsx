import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { TransferForm } from "./TransferForm";

export const metadata = { title: "Wysyłka na inny magazyn" };

/** Przesunięcie między magazynami: skan rzeczy, lista do paczki, przyjęcie w Przyjęciu dostawy → W drodze. */
export default async function TransferPage() {
  const { supabase } = await requireProfile();
  const [{ data: locations }, { data: stores }] = await Promise.all([
    supabase.from("locations").select("id, name, store_id").eq("active", true).order("name"),
    supabase.from("stores").select("id, name"),
  ]);
  const storeName = new Map((stores ?? []).map((s) => [s.id, s.name]));
  const locs = (locations ?? []).map((l) => ({ id: l.id as string, label: `${storeName.get(l.store_id) ?? ""} · ${l.name}` }));
  return (
    <>
      <PageHeader
        title="Wysyłka na inny magazyn"
        sub="Wybierz skąd i dokąd, zeskanuj rzeczy i wydrukuj listę do paczki. Rzeczy wracają na stan (+1 w Shopify) po przyjęciu w magazynie docelowym."
        actions={<><Link className="btn-secondary" href="/dostawa?zakladka=w-drodze">W drodze</Link><Link className="btn-secondary" href="/magazyn">Wróć do Magazynu</Link></>}
      />
      <TransferForm locations={locs} defaultFrom={locs.length === 1 ? locs[0].id : ""} />
    </>
  );
}
