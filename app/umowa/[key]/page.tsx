import type { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/admin";
import { getBuyerSignature, getCompany } from "@/lib/contracts/settings";
import { SellerContractForm } from "@/components/contracts/SellerContractForm";
import { submitGeneralContract } from "@/app/podpis/actions";
import { searchCatalogPublic } from "../actions";
import { PublicShell } from "@/app/podpis/PublicShell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Umowa kupna", robots: { index: false, follow: false } };

export default async function GeneralContractPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const db = createAdminClient();
  const [company, buyerSignature] = await Promise.all([getCompany(db), getBuyerSignature(db)]);
  const { data } = await db.from("app_settings").select("value").eq("key", "general_contract_link").maybeSingle();
  const cfg = data?.value as { key?: string; enabled?: boolean } | undefined;
  if (!cfg?.enabled || cfg.key !== key) {
    return <PublicShell company={company.name}><div className="card mx-auto max-w-lg p-6">Ten link jest nieaktywny. Skontaktuj się z nami: {company.email}</div></PublicShell>;
  }
  return (
    <PublicShell company={company.name}>
      <h1 className="h1 mb-3">Umowa kupna</h1>
      <SellerContractForm
        action={submitGeneralContract.bind(null, key)}
        mode="free"
        company={company}
        number="…"
        date={new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw" }).format(new Date())}
        paymentDays={company.payment_days ?? 7}
        buyerSignature={buyerSignature}
        searchCatalog={searchCatalogPublic.bind(null, key)}
        items={[]}
      />
    </PublicShell>
  );
}
