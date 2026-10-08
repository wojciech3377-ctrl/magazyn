import type { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/admin";
import { getBuyerSignature, getCompany } from "@/lib/contracts/settings";
import { SellerContractForm } from "@/components/contracts/SellerContractForm";
import { signLinkedContract } from "../actions";
import { PublicShell } from "../PublicShell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Umowa kupna – podpis", robots: { index: false, follow: false } };

export default async function SignPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const db = createAdminClient();
  const [company, buyerSignature] = await Promise.all([getCompany(db), getBuyerSignature(db)]);
  const { data: c } = /^[a-f0-9]{32,64}$/.test(token)
    ? await db.from("contracts").select("id, number, status, sign_expires_at, items, payment_days, seller_name, seller_email").eq("sign_token", token).maybeSingle()
    : { data: null };

  if (!c || c.status === "cancelled") {
    return <PublicShell company={company.name}><div className="card mx-auto max-w-lg p-6">Ten link jest nieaktywny. Skontaktuj się z nami: {company.email}</div></PublicShell>;
  }
  if (c.status === "signed") {
    return (
      <PublicShell company={company.name}>
        <div className="card mx-auto max-w-lg space-y-3 p-6">
          <h1 className="h1">Dziękujemy, umowa nr {c.number} jest podpisana</h1>
          <p className="text-sm text-muted">{c.seller_email ? `Kopia umowy trafi też na ${c.seller_email}. ` : ""}Możesz ją pobrać poniżej.</p>
          <a className="btn" href={`/podpis/pdf/${token}`}>Pobierz umowę (PDF)</a>
        </div>
      </PublicShell>
    );
  }
  if (c.sign_expires_at && new Date(c.sign_expires_at) < new Date()) {
    return <PublicShell company={company.name}><div className="card mx-auto max-w-lg p-6">Link wygasł. Poproś o nowy: {company.email}</div></PublicShell>;
  }

  const action = signLinkedContract.bind(null, token);
  return (
    <PublicShell company={company.name}>
      <h1 className="h1 mb-3">Umowa kupna nr {c.number}</h1>
      <SellerContractForm
        action={action}
        mode="fixed"
        company={company}
        number={String(c.number)}
        date={new Date().toISOString().slice(0, 10)}
        paymentDays={c.payment_days ?? company.payment_days ?? 7}
        buyerSignature={buyerSignature}
        items={(c.items ?? []).map((i: { title: string; option: string; identifier?: string | null; qty?: number; price: number }) => ({ title: i.title, option: i.option, identifier: i.identifier ?? null, qty: Number(i.qty ?? 1), price: Number(i.price) }))}
      />
    </PublicShell>
  );
}
