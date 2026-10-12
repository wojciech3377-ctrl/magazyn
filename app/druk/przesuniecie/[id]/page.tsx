import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { dateTime } from "@/lib/labels";
import { PrintButton } from "@/app/etykiety/Barcode";
import { AutoPrint } from "./AutoPrint";

export const metadata = { title: "Przesunięcie – lista do paczki" };
export const dynamic = "force-dynamic";

/** Lista rzeczy w przesunięciu między magazynami – do włożenia do paczki. */
export default async function PrintTransfer({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const { supabase } = await requireProfile();
  const { data: t } = await supabase.from("stock_transfers")
    .select("id, number, status, note, created_at, from:locations!stock_transfers_from_location_id_fkey(name, store:stores(name)), to:locations!stock_transfers_to_location_id_fkey(name, store:stores(name))")
    .eq("id", id).maybeSingle();
  if (!t) notFound();
  const { data: items } = await supabase.from("stock_transfer_items").select("unit_id, received_at").eq("transfer_id", id);
  const ids = (items ?? []).map((i) => i.unit_id as string);
  const { data: units } = ids.length ? await supabase.from("units_list").select("id, code, title, option, style_sku, identifier").in("id", ids) : { data: [] };
  const sorted = [...(units ?? [])].sort((a, b) => String(a.title).localeCompare(String(b.title), "pl") || String(a.option).localeCompare(String(b.option), "pl", { numeric: true }));
  type L = { name: string; store: { name: string } | null } | null;
  const from = t.from as unknown as L;
  const to = t.to as unknown as L;
  const label = (l: L) => (l ? `${l.store?.name ?? ""} · ${l.name}` : "–");

  return (
    <main className="mx-auto max-w-3xl p-6 text-black">
      <style>{`@media print { .no-print { display: none !important; } @page { size: A4; margin: 12mm; } tr { break-inside: avoid; } }`}</style>
      {sp.drukuj === "1" && <AutoPrint />}
      <div className="no-print mb-4 flex flex-wrap items-center justify-between gap-2">
        <Link className="text-sm text-accent hover:underline" href="/magazyn/przesuniecie">← Nowa wysyłka na inny magazyn</Link>
        <div className="flex gap-2">
          <Link className="btn-secondary" href="/dostawa?zakladka=w-drodze">Przyjęcie dostawy → W drodze</Link>
          <PrintButton />
        </div>
      </div>
      {sp.uwaga && <p className="no-print mb-4 rounded border border-amber-300 bg-amber-50 p-2 text-sm">Uwaga – stan w Shopify nie został zmieniony automatycznie: {sp.uwaga}</p>}
      <h1 className="text-xl font-bold">Przesunięcie nr {t.number}</h1>
      <p className="mb-1 text-sm">{dateTime(t.created_at)} · {sorted.length} szt.{t.status !== "in_transit" ? ` · ${t.status === "received" ? "przyjęte" : "anulowane"}` : ""}</p>
      <p className="mb-4 text-base"><b>Z:</b> {label(from)} <span className="mx-2">→</span> <b>Do:</b> {label(to)}</p>
      {t.note && <p className="mb-3 text-sm"><b>Uwagi:</b> {t.note}</p>}
      <table className="w-full border-collapse text-sm">
        <thead><tr className="border-b-2 border-black text-left"><th className="w-8 py-1">✓</th><th className="w-8 py-1">Lp.</th><th className="py-1">Rzecz</th><th className="w-20 py-1">Rozmiar</th><th className="w-28 py-1">Kod</th></tr></thead>
        <tbody>
          {sorted.map((u, i) => (
            <tr key={u.id} className="border-b border-slate-300 align-top">
              <td className="py-1.5"><span className="inline-block h-4 w-4 border border-black" /></td>
              <td className="py-1.5">{i + 1}</td>
              <td className="py-1.5"><b>{u.title}</b>{u.style_sku && <span className="block font-mono text-xs">{u.style_sku}</span>}{u.identifier && <span className="block font-mono text-xs">{u.identifier}</span>}</td>
              <td className="py-1.5 text-base font-bold">{u.option}</td>
              <td className="py-1.5 font-mono">{u.code}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-10 grid grid-cols-2 gap-10 text-sm">
        <div className="border-t border-black pt-1">Wydał (podpis)</div>
        <div className="border-t border-black pt-1">Przyjął (podpis, data)</div>
      </div>
    </main>
  );
}
