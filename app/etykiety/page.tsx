import { requireProfile } from "@/lib/auth";
import { Barcode, PrintButton } from "./Barcode";

/** Etykiety 50 × 30 mm: kod sztuki jako kod kreskowy, produkt i rozmiar. */
export default async function LabelsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const raw = Array.isArray(sp.ids) ? sp.ids : (sp.ids ?? "").split(",");
  const ids = raw.flatMap((x) => x.split(",")).map((x) => x.trim()).filter(Boolean).slice(0, 500);
  const { supabase } = await requireProfile();
  const { data: units } = ids.length
    ? await supabase.from("units").select("id, code, identifier, variant:variants(option, product:products(title, style_sku)), location:locations(store:stores(name))").in("id", ids).order("number")
    : { data: [] };

  return (
    <div>
      <style>{`
        @page { size: 50mm 30mm; margin: 0; }
        @media print { .no-print { display: none !important; } body { background: #fff; } .sheet { gap: 0 !important; padding: 0 !important; } }
        .label { width: 50mm; height: 30mm; padding: 2mm 2.5mm; box-sizing: border-box; overflow: hidden; break-after: page; page-break-after: always; }
      `}</style>
      <div className="no-print flex items-center justify-between border-b border-line p-4">
        <span className="text-sm text-muted">{units?.length ?? 0} etykiet · drukarka etykiet 50 × 30 mm</span>
        <PrintButton />
      </div>
      {!units?.length && <p className="no-print p-4 text-sm text-muted">Nie wybrano żadnych sztuk. Zaznacz sztuki w Magazynie i kliknij „Drukuj etykietę”.</p>}
      <div className="sheet flex flex-wrap gap-2 p-4">
        {units?.map((u) => {
          const v = u.variant as unknown as { option: string; product: { title: string; style_sku: string | null } };
          const store = (u.location as unknown as { store: { name: string } }).store.name;
          return (
            <div key={u.id} className="label flex flex-col justify-between border border-dashed border-line bg-white text-black print:border-0">
              <div className="flex items-start justify-between gap-1 leading-tight">
                <span className="line-clamp-2 text-[7.5pt] font-semibold">{v.product.title}</span>
                <span className="shrink-0 text-[11pt] font-bold">{v.option}</span>
              </div>
              <Barcode value={u.code} />
              <div className="flex justify-between font-mono text-[7pt]">
                <span className="font-bold">{u.code}</span>
                <span>{v.product.style_sku ?? store}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
