import { requireProfile } from "@/lib/auth";
import { dateTime, money } from "@/lib/labels";
import type { LineItem } from "@/lib/sync/shop-orders";
import { PrintButton } from "@/app/etykiety/Barcode";

export const metadata = { title: "Nowe zamówienia – do spakowania" };
export const dynamic = "force-dynamic";

/** Lista do spakowania: wszystkie nowe (aktywne, niewysłane) zamówienia z przedmiotami, rozmiarem, kodem i półką. */
export default async function PrintNewOrders() {
  const { supabase } = await requireProfile();
  const { data: orders } = await supabase.from("orders")
    .select("id, name, ordered_at, customer_name, shipping_method, pickup_point, note, line_items, store:stores(name)")
    .eq("status", "new").order("ordered_at").limit(300);
  const ids = (orders ?? []).map((o) => o.id);
  const { data: sales } = ids.length
    ? await supabase.from("sales").select("order_id, shopify_line_id, status, unit:units(code, shelf, location:locations(name))").in("order_id", ids).neq("status", "cancelled")
    : { data: [] };
  type S = { order_id: string; shopify_line_id: string | null; unit: { code: string; shelf: string | null; location: { name: string } | null } | null };
  const byLine = new Map<string, S[]>();
  for (const s of (sales ?? []) as unknown as S[]) byLine.set(`${s.order_id}|${s.shopify_line_id}`, [...(byLine.get(`${s.order_id}|${s.shopify_line_id}`) ?? []), s]);
  const pieces = (orders ?? []).reduce((n, o) => n + ((o.line_items ?? []) as LineItem[]).reduce((m, l) => m + l.quantity, 0), 0);

  return (
    <main className="mx-auto max-w-4xl p-6 text-black">
      <style>{`@media print { .no-print { display: none !important; } @page { size: A4; margin: 12mm; } .order { break-inside: avoid; } }`}</style>
      <div className="no-print mb-4 flex items-center justify-between">
        <span className="text-sm text-muted">{orders?.length ?? 0} nowych zamówień · {pieces} szt.</span>
        <PrintButton />
      </div>
      <h1 className="mb-1 text-xl font-bold">Do spakowania – nowe zamówienia</h1>
      <p className="mb-4 text-sm">{dateTime(new Date().toISOString())} · {orders?.length ?? 0} zamówień · {pieces} szt.</p>
      {!orders?.length && <p>Brak nowych zamówień.</p>}
      <div className="space-y-3">
        {orders?.map((o) => (
          <section key={o.id} className="order rounded border border-slate-300 p-3">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-200 pb-1">
              <b className="text-base">{o.name}</b>
              <span className="text-sm">{(o.store as unknown as { name: string } | null)?.name} · {dateTime(o.ordered_at)}</span>
              <span className="text-sm">{o.customer_name} · {o.shipping_method ?? "–"}{o.pickup_point ? ` (${o.pickup_point})` : ""}</span>
            </div>
            <table className="w-full text-sm">
              <tbody>
                {((o.line_items ?? []) as LineItem[]).map((l) => {
                  const units = byLine.get(`${o.id}|${l.id}`) ?? [];
                  return (
                    <tr key={l.id} className="align-top">
                      <td className="w-6 py-1"><span className="inline-block h-4 w-4 border border-black" /></td>
                      <td className="w-14 py-1">{l.image ? <img src={`${l.image}${l.image.includes("?") ? "&" : "?"}width=100`} alt="" className="h-12 w-12 object-contain" /> : null}</td>
                      <td className="py-1"><b>{l.title}</b>{l.sku && <span className="block font-mono text-xs">{l.sku}</span>}</td>
                      <td className="w-20 py-1 text-lg font-bold">{l.variant_title ?? "–"}</td>
                      <td className="w-10 py-1 text-right">{l.quantity > 1 ? <b>×{l.quantity}</b> : "×1"}</td>
                      <td className="w-40 py-1 text-right font-mono text-xs">
                        {units.length ? units.map((s, i) => <span key={i} className="block">{s.unit ? `${s.unit.code}${s.unit.shelf ? ` · ${s.unit.shelf}` : ""}` : "brak sztuki"}</span>) : <span>–</span>}
                      </td>
                      <td className="w-20 py-1 text-right">{money(l.price)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {o.note && <p className="mt-1 text-xs"><b>Uwagi:</b> {o.note}</p>}
          </section>
        ))}
      </div>
    </main>
  );
}
