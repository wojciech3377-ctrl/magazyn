import { requireProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { fmtRange, priceTags } from "@/lib/price-tag";
import { Barcode, PrintButton } from "../etykiety/Barcode";

export const metadata = { title: "Metki sklepowe" };
export const dynamic = "force-dynamic";

/** Metka sklepowa 57 × 32 mm: nazwa, cena (zakres po rozmiarach), promocja, najniższa cena z 30 dni, kod SKU z Base. */
export default async function PriceTagPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const raw = Array.isArray(sp.ids) ? sp.ids : (sp.ids ?? "").split(",");
  const ids = raw.flatMap((x) => x.split(",")).map((x) => x.trim()).filter((x) => /^[0-9a-f-]{36}$/.test(x)).slice(0, 200);
  await requireProfile();
  const tags = ids.length ? await priceTags(createAdminClient(), ids) : [];
  const fields = [...new Set(tags.flatMap((t) => t.omnibusFields))];
  const incomplete = tags.some((t) => t.lowestSource !== "aplikacja Omnibus (Shopify)" && !t.historyComplete);

  return (
    <div>
      <style>{`
        @page { size: 57mm 32mm; margin: 0; }
        @media print { .no-print { display: none !important; } body { background: #fff; } .sheet { gap: 0 !important; padding: 0 !important; } }
        .tag { width: 57mm; height: 32mm; padding: 1.8mm 2.2mm; box-sizing: border-box; overflow: hidden; break-after: page; page-break-after: always; font-family: Arial, Helvetica, sans-serif; }
      `}</style>
      <div className="no-print space-y-2 border-b border-line p-4 text-sm">
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted">{tags.length} metek · naklejka 57 × 32 mm</span>
          <PrintButton />
        </div>
        <p className="text-xs text-muted">
          Najniższa cena z 30 dni: {fields.length ? <>z metapól aplikacji Omnibus w Shopify ({fields.join(", ")})</> : "aplikacja Omnibus nie udostępnia metapól w Shopify – liczona z historii cen zapisywanej przez aplikację"}.
          {incomplete && " Historia cen jest jeszcze krótsza niż 30 dni – dla promocji sprawdź tę cenę w aplikacji Omnibus."}
        </p>
      </div>
      {!tags.length && <p className="no-print p-4 text-sm text-muted">Nie wybrano żadnych sztuk. W Magazynie kliknij „Wydrukuj metkę” przy produkcie albo zaznacz kilka i „Wydrukuj metki”.</p>}
      <div className="sheet flex flex-wrap gap-2 p-4">
        {tags.map((t) => (
          <div key={t.unitId} className="tag flex flex-col border border-dashed border-line bg-white text-black print:border-0">
            <div className="line-clamp-2 text-[8pt] font-bold leading-[1.15]">{t.title}</div>
            {t.promo && t.compareAt && <div className="mt-[0.5mm] whitespace-nowrap text-[6.5pt] leading-tight">Cena przed obniżką: <s>{fmtRange(t.compareAt)}</s></div>}
            <div className={`${t.promo ? "" : "mt-[0.8mm]"} whitespace-nowrap ${(t.promo ? 7 : 0) + fmtRange(t.price).length > 16 ? "text-[10pt]" : "text-[12pt]"} font-bold leading-none`}>{t.promo ? "Teraz: " : ""}{fmtRange(t.price)}</div>
            <div className="text-[5.5pt] leading-tight">Najniższa cena z 30 dni{t.promo ? " przed obniżką" : ""}: {fmtRange(t.lowest30)}</div>
            <div className="mt-auto">
              <Barcode value={t.sku} className={`${t.promo ? "h-[5.5mm]" : "h-[6.5mm]"} w-full`} />
              <div className="flex justify-between text-[6.5pt] leading-tight">
                <span>SKU: {t.sku}</span>
                <span className="font-bold">Rozm. {t.option}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
