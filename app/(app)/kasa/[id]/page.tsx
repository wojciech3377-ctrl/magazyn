import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { dateTime, money } from "@/lib/labels";
import { Notice, PageHeader } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { retryPosBase } from "../actions";

const PAYMENT: Record<string, string> = { card: "karta", cash: "gotówka", blik: "BLIK", transfer: "przelew", other: "inna" };

export default async function PosOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase } = await requireProfile();
  const { data: o } = await supabase.from("pos_orders").select("*, store:stores(name)").eq("id", id).maybeSingle();
  if (!o) notFound();
  const { data: items } = await supabase
    .from("pos_order_items")
    .select("id, price, status, unit:units(id, code, identifier, variant:variants(option, product:products(title)))")
    .eq("order_id", id);

  return (
    <>
      <PageHeader
        title={`Sprzedaż ${o.code}`}
        sub={`${(o.store as { name: string }).name} · ${dateTime(o.created_at)} · płatność: ${PAYMENT[o.payment_method] ?? o.payment_method}${o.customer ? ` · ${o.customer}` : ""}`}
        actions={<Link className="btn" href="/kasa">Nowa sprzedaż</Link>}
      />
      <div className="mb-4">
        {o.base_sync_status === "ok" && <Notice tone="ok">Stan w Base zmniejszony. Base zaktualizuje sklepy.</Notice>}
        {o.base_sync_status === "error" && (
          <Notice tone="error">
            <div className="whitespace-pre-line">Base: {o.base_sync_error}</div>
            {(o.base_pending as unknown[]).length > 0 && (
              <form action={retryPosBase} className="mt-2">
                <input type="hidden" name="id" value={o.id} />
                <SubmitButton className="btn-secondary" pendingText="Wysyłam…">Wyślij ponownie do Base</SubmitButton>
              </form>
            )}
          </Notice>
        )}
      </div>
      <div className="card overflow-x-auto">
        <table className="table">
          <thead><tr><th>Sztuka</th><th>Produkt</th><th className="text-right">Cena</th></tr></thead>
          <tbody>
            {items?.map((i) => {
              const u = i.unit as unknown as { id: string; code: string; identifier: string | null; variant: { option: string; product: { title: string } } };
              return (
                <tr key={i.id}>
                  <td className="font-mono text-xs"><Link className="text-accent hover:underline" href={`/magazyn/${u.id}`}>{u.code}</Link>{u.identifier && <span className="block text-muted">{u.identifier}</span>}</td>
                  <td>{u.variant.product.title} · <b>{u.variant.option}</b>{i.status === "returned" && <span className="ml-2 text-xs text-bad">zwrot</span>}</td>
                  <td className="text-right tabular-nums">{money(i.price)}</td>
                </tr>
              );
            })}
            <tr><td colSpan={2} className="text-right font-medium">Razem</td><td className="text-right text-lg font-semibold tabular-nums">{money(o.total)}</td></tr>
          </tbody>
        </table>
      </div>
    </>
  );
}
