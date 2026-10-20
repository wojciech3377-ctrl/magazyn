import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireSection } from "@/lib/auth";
import { dateOnly, money } from "@/lib/labels";
import { Notice, PageHeader } from "@/components/ui";
import { VariantPick } from "@/components/VariantPick";
import { SubmitButton } from "@/components/SubmitButton";
import { createUnitForLine } from "../../actions";

export const metadata = { title: "Dołącz umowę" };

/**
 * „Dołącz umowę” do pozycji bez sztuki z magazynu (sprzedaż w Kasie wpisana z nazwy / produkt własny,
 * faktura wystawiona ręcznie): najpierw produkt i rozmiar z katalogu – powstaje sprzedana sztuka –
 * potem zwykły wybór umowy (gotowa, skan albo do podpisu).
 */
export default async function LineContractPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { supabase } = await requireSection("sprzedaz", "faktury");
  const m = /^(pos|fv):([0-9a-f-]{36})$/.exec(sp.ref ?? "");
  if (!m) notFound();
  const back = (sp.back?.startsWith("/sprzedaz") || sp.back?.startsWith("/magazyn")) && !sp.back.startsWith("//") ? sp.back : "/sprzedaz?widok=jpk";

  let info: { name: string; price: number | null; unitId: string | null; doc: React.ReactNode; date: string | null; storeId: string };
  if (m[1] === "pos") {
    const { data } = await supabase.from("pos_order_items").select("id, name, price, quantity, unit_id, order:pos_orders(id, code, store_id, created_at)").eq("id", m[2]).maybeSingle();
    if (!data) notFound();
    const o = data.order as unknown as { id: string; code: string; store_id: string; created_at: string } | null;
    info = {
      name: `${data.name ?? "pozycja"}${Number(data.quantity ?? 1) !== 1 ? ` × ${Number(data.quantity)}` : ""}`, price: Number(data.price), unitId: data.unit_id as string | null,
      doc: o ? <>sprzedaż stacjonarna <Link className="text-accent hover:underline" href={`/kasa/${o.id}`}>{o.code}</Link></> : "sprzedaż stacjonarna",
      date: o?.created_at ?? null, storeId: o?.store_id ?? "",
    };
  } else {
    const { data } = await supabase.from("invoice_items").select("id, name, total_gross, unit_id, invoice:invoices(id, number, issue_date)").eq("id", m[2]).maybeSingle();
    if (!data) notFound();
    const inv = data.invoice as unknown as { id: string; number: string; issue_date: string } | null;
    info = {
      name: data.name as string, price: Number(data.total_gross), unitId: data.unit_id as string | null,
      doc: inv ? <>faktura <Link className="text-accent hover:underline" href={`/sprzedaz/faktury/${inv.id}`}>{inv.number}</Link></> : "faktura",
      date: inv?.issue_date ?? null, storeId: "",
    };
  }
  // Sztuka już jest – od razu dołączanie umowy.
  if (info.unitId) redirect(`/sprzedaz/umowa?sztuka=${info.unitId}&back=${encodeURIComponent(back)}`);

  return (
    <>
      <PageHeader
        title="Dołącz umowę"
        sub={<>{info.name} · {money(info.price)} · {info.doc}{info.date ? ` · ${dateOnly(info.date)}` : ""}</>}
        actions={<Link className="btn-secondary" href={back}>Wróć</Link>}
      />
      {sp.blad && <div className="mb-4"><Notice tone="error">{sp.blad}</Notice></div>}
      <form action={createUnitForLine} className="card max-w-xl space-y-3 p-4">
        <input type="hidden" name="ref" value={sp.ref} />
        <input type="hidden" name="back" value={back} />
        <Notice>Ta pozycja nie ma sztuki z magazynu (była wpisana z nazwy). Wybierz produkt i rozmiar z katalogu – albo, jeśli go nie ma w katalogu, kliknij „Bez katalogu – dalej”. Powstanie sprzedana sztuka z datą tej sprzedaży, a potem dołączysz do niej umowę: wolną (niewykorzystaną), skan albo do podpisu.</Notice>
        <VariantPick name="variant_id" storeId={info.storeId} label="Produkt z katalogu (opcjonalnie)" />
        <div className="flex flex-wrap gap-2">
          <SubmitButton className="btn" pendingText="Tworzę sztukę…">Dalej – wybór umowy</SubmitButton>
          <SubmitButton className="btn-secondary" name="offcatalog" value="1" formNoValidate pendingText="Tworzę sztukę…">Bez katalogu – dalej („{info.name}”)</SubmitButton>
        </div>
      </form>
    </>
  );
}
