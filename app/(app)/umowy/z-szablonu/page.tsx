import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { getCompany } from "@/lib/contracts/settings";
import { mailConfigured } from "@/lib/mail";
import { PageHeader } from "@/components/ui";
import { TemplateContractForm, type Line } from "./TemplateContractForm";

export default async function TemplateContractPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const { supabase } = await requireProfile();
  const ids = ([] as string[]).concat(sp.ids ?? []).flatMap((x) => x.split(",")).filter((x) => /^[0-9a-f-]{36}$/.test(x)).slice(0, 100);
  const saleId = typeof sp.sprzedaz === "string" && /^[0-9a-f-]{36}$/.test(sp.sprzedaz) ? sp.sprzedaz : null;

  const [company, { data: locations }, { data: stores }] = await Promise.all([
    getCompany(supabase),
    supabase.from("locations").select("id, name, store_id").eq("active", true).order("name"),
    supabase.from("stores").select("id, name"),
  ]);
  const storeName = new Map((stores ?? []).map((s) => [s.id, s.name]));
  let lines: Line[] = [];
  let saleRef: string | null = null;
  let defaultLocation: string | null = null;

  if (ids.length) {
    const { data: units } = await supabase.from("units")
      .select("id, code, identifier, purchase_price, location_id, variant:variants(option, product:products(title))").in("id", ids);
    lines = (units ?? []).map((u) => {
      const v = u.variant as unknown as { option: string; product: { title: string } };
      return { key: u.id, unit_id: u.id, title: v.product.title, option: v.option, identifier: u.identifier, code: u.code, qty: 1, price: u.purchase_price ? String(u.purchase_price) : "" };
    });
    defaultLocation = units?.[0]?.location_id ?? null;
  }
  if (saleId) {
    const { data: s } = await supabase.from("sales").select("id, order_ref, store_id, variant_id, variant:variants(option, product:products(title))").eq("id", saleId).single();
    if (s?.variant_id) {
      const v = s.variant as unknown as { option: string; product: { title: string } };
      lines = [{ key: s.id, variant_id: s.variant_id, title: v.product.title, option: v.option, qty: 1, price: "" }];
    }
    saleRef = s?.order_ref ?? null;
    defaultLocation = (locations ?? []).find((l) => l.store_id === s?.store_id)?.id ?? null;
  }

  return (
    <>
      <PageHeader
        title="Umowa kupna z szablonu"
        sub="Ty ustalasz, co kupujesz i za ile. Sprzedający dostaje link, wpisuje swoje dane i podpisuje."
        actions={<Link className="btn-secondary" href={`/umowy/nowa${ids.length ? `?${ids.map((i) => `ids=${i}`).join("&")}` : ""}`}>Mam papierową umowę – wgraj skan</Link>}
      />
      <TemplateContractForm
        initialLines={lines}
        saleId={saleId}
        saleRef={saleRef}
        locations={(locations ?? []).map((l) => ({ id: l.id, store_id: l.store_id, label: `${storeName.get(l.store_id)} · ${l.name}` }))}
        defaultLocation={defaultLocation}
        paymentDays={company.payment_days ?? 7}
        mailReady={mailConfigured()}
      />
    </>
  );
}
