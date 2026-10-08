import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { dateTime, money } from "@/lib/labels";
import { Notice, PageHeader, StatusBadge } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { retryDeliveryBase } from "../actions";

export default async function DeliveryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase, profile } = await requireProfile();
  const { data: d } = await supabase.from("deliveries").select("*, store:stores(name), location:locations(name)").eq("id", id).maybeSingle();
  if (!d) notFound();
  const { data: units } = await supabase
    .from("units")
    .select("id, code, status, identifier, purchase_price, variant:variants(option, product:products(title))")
    .eq("delivery_id", id)
    .order("number");
  const ids = (units ?? []).map((u) => u.id).join(",");

  return (
    <>
      <PageHeader
        title={`Dostawa · ${units?.length ?? 0} szt.`}
        sub={`${(d.store as { name: string }).name} · ${(d.location as { name: string }).name} · ${dateTime(d.created_at)}`}
        actions={
          <>
            <Link className="btn" href={`/etykiety?ids=${ids}`} target="_blank">Drukuj etykiety ({units?.length})</Link>
            <Link className="btn-secondary" href="/dostawa">Następna dostawa</Link>
          </>
        }
      />
      <div className="mb-4 space-y-2">
        {d.base_sync_status === "ok" && <Notice tone="ok">Stan w Base zaktualizowany. Base zmieni stan w sklepie przy najbliższej synchronizacji.</Notice>}
        {d.base_sync_status === "skipped" && <Notice>Towar w drodze – stan w Base podniesiesz, przyjmując sztuki na stan w Magazynie.</Notice>}
        {d.base_sync_status === "error" && (
          <Notice tone="error">
            <div className="whitespace-pre-line">Base: {d.base_sync_error}</div>
            {(d.base_pending as unknown[]).length > 0 && (
              <form action={retryDeliveryBase} className="mt-2">
                <input type="hidden" name="id" value={d.id} />
                <SubmitButton className="btn-secondary" pendingText="Wysyłam…">Wyślij ponownie do Base</SubmitButton>
              </form>
            )}
          </Notice>
        )}
      </div>
      <div className="card overflow-x-auto">
        <table className="table">
          <thead><tr><th>Kod</th><th>Produkt</th><th>Rozmiar</th><th>IMEI / nr</th>{profile.can_see_prices && <th className="text-right">Cena</th>}<th>Status</th></tr></thead>
          <tbody>
            {units?.map((u) => {
              const v = u.variant as unknown as { option: string; product: { title: string } };
              return (
                <tr key={u.id}>
                  <td className="font-mono text-xs"><Link className="text-accent hover:underline" href={`/magazyn/${u.id}`}>{u.code}</Link></td>
                  <td>{v.product.title}</td>
                  <td className="font-medium">{v.option}</td>
                  <td className="font-mono text-xs">{u.identifier ?? "–"}</td>
                  {profile.can_see_prices && <td className="text-right tabular-nums">{money(u.purchase_price)}</td>}
                  <td><StatusBadge status={u.status} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
