import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { InventoryScanner } from "./InventoryScanner";

export const metadata = { title: "Inwentaryzacja" };

/** Inwentaryzacja: skan każdej rzeczy w lokalizacji, na koniec lista braków i nadwyżek. */
export default async function InventoryPage() {
  const { supabase } = await requireProfile();
  const [{ data: locations }, { data: stores }] = await Promise.all([
    supabase.from("locations").select("id, name, store_id").eq("active", true).order("name"),
    supabase.from("stores").select("id, name"),
  ]);
  const storeName = new Map((stores ?? []).map((s) => [s.id, s.name]));
  return (
    <>
      <PageHeader title="Inwentaryzacja" sub="Wybierz lokalizację i skanuj kod kreskowy każdej rzeczy (kod sztuki, SKU, EAN). Na końcu zobaczysz, czego brakuje i co jest ponad stan." actions={<Link className="btn-secondary" href="/magazyn">Wróć do Magazynu</Link>} />
      <InventoryScanner locations={(locations ?? []).map((l) => ({ id: l.id as string, label: `${storeName.get(l.store_id) ?? ""} · ${l.name}` }))} />
    </>
  );
}
