import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { getBuyerSignature, getCompany } from "@/lib/contracts/settings";
import { SellerContractForm } from "@/components/contracts/SellerContractForm";
import { signLinkedContract } from "../actions";
import { PublicShell } from "../PublicShell";
import { InvoiceOption } from "./InvoiceOption";
import { pdfExpired } from "../pdf-expiry";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Umowa kupna – podpis", robots: { index: false, follow: false } };

export default async function SignPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const db = createAdminClient();
  const [company, buyerSignature] = await Promise.all([getCompany(db), getBuyerSignature(db)]);
  const { data: c } = /^[a-f0-9]{32,64}$/.test(token)
    ? await db.from("contracts").select("id, number, status, sign_expires_at, items, payment_days, seller_name, seller_email, group_id, currency, type, doc_number, source, accepted_at").eq("sign_token", token).maybeSingle()
    : { data: null };

  if (!c || c.status === "cancelled") {
    return <PublicShell company={company.name}><div className="card mx-auto max-w-lg p-6">Ten link jest nieaktywny. Skontaktuj się z nami: {company.email}</div></PublicShell>;
  }
  // Sprzedający wgrał fakturę zamiast podpisywać umowę.
  if (c.type === "invoice" && (c.status === "signed" || c.status === "accepted")) {
    return (
      <PublicShell company={company.name}>
        <div className="card mx-auto max-w-lg space-y-3 p-6">
          <h1 className="h1">Dziękujemy, faktura {c.doc_number} jest u nas</h1>
          <p className="text-sm text-muted">{c.status === "accepted" ? "Fakturę zatwierdziliśmy." : "Sprawdzimy ją i zatwierdzimy po naszej stronie."} / Thank you – we have received your invoice.</p>
        </div>
      </PublicShell>
    );
  }
  if (c.status === "signed") {
    return (
      <PublicShell company={company.name}>
        <div className="card mx-auto max-w-lg space-y-3 p-6">
          <h1 className="h1">Dziękujemy, umowa NR{c.number} jest podpisana</h1>
          <p className="text-sm text-muted">Teraz zatwierdzimy ją po naszej stronie. {c.seller_email ? `Umowę podpisaną przez obie strony wyślemy na ${c.seller_email}, a także` : "Umowę podpisaną przez obie strony"} pobierzesz pod tym samym linkiem.</p>
          <p className="text-sm text-muted">Thank you! We will now approve the agreement. The copy signed by both parties will be available at this link{c.seller_email ? " and sent to your e-mail" : ""}.</p>
        </div>
      </PublicShell>
    );
  }
  if (c.status === "accepted" && pdfExpired(c.accepted_at as string | null)) {
    return <PublicShell company={company.name}><div className="card mx-auto max-w-lg p-6">Umowa NR{c.number} jest zawarta. Link do pobrania wygasł (ochrona danych) – po kopię umowy napisz do nas: {company.email}</div></PublicShell>;
  }
  if (c.status === "accepted") {
    // Kilka rzeczy = osobna umowa dla każdej (wspólna grupa) – wszystkie do pobrania z tego linku.
    const groupId = (c.group_id as string | null) ?? c.id;
    const { data: group } = await db.from("contracts").select("number, sign_token, items").or(`id.eq.${groupId},group_id.eq.${groupId}`).eq("status", "accepted").order("number");
    const list = (group ?? []).length > 1 ? group! : null;
    return (
      <PublicShell company={company.name}>
        <div className="card mx-auto max-w-lg space-y-3 p-6">
          <h1 className="h1">{list ? `Umowy ${list.map((g) => `NR${g.number}`).join(", ")} są zawarte` : `Umowa NR${c.number} jest zawarta`}</h1>
          <p className="text-sm text-muted">Podpisane przez obie strony{list ? " – osobna umowa dla każdej rzeczy" : ""}. / Signed by both parties{list ? " – a separate agreement for each item" : ""}.</p>
          {list ? (
            <ul className="space-y-2">
              {list.map((g) => {
                const it = ((g.items ?? []) as { title?: string; option?: string }[])[0];
                return (
                  <li key={g.sign_token as string} className="flex items-center justify-between gap-3 rounded-lg border border-line p-3 text-sm">
                    <span className="min-w-0"><b>Umowa NR{g.number}</b><span className="block truncate text-muted">{[it?.title, it?.option].filter(Boolean).join(" ")}</span></span>
                    <a className="btn-secondary shrink-0" href={`/podpis/pdf/${g.sign_token}`}>PDF</a>
                  </li>
                );
              })}
            </ul>
          ) : <a className="btn" href={`/podpis/pdf/${token}`}>Pobierz umowę (PDF) / Download (PDF)</a>}
        </div>
      </PublicShell>
    );
  }
  if (c.status === "offer") redirect(`/podpis/${token}/oferta`);
  if (c.status === "rejected") {
    return <PublicShell company={company.name}><div className="card mx-auto max-w-lg p-6">Umowa NR{c.number} nie została zaakceptowana. Skontaktuj się z nami: {company.email}</div></PublicShell>;
  }
  if (c.sign_expires_at && new Date(c.sign_expires_at) < new Date()) {
    return <PublicShell company={company.name}><div className="card mx-auto max-w-lg p-6">Link wygasł. Poproś o nowy: {company.email}</div></PublicShell>;
  }

  const action = signLinkedContract.bind(null, token);
  return (
    <PublicShell company={company.name}>
      <h1 className="h1 mb-3">Umowa kupna NR{c.number}</h1>
      {/* Umowa od sklepu (nie komisant – ten wgrywa faktury w swoim panelu): firma może wgrać fakturę zamiast podpisu. */}
      {c.source !== "consignor" && <InvoiceOption token={token} currency={c.currency ?? null} />}
      <SellerContractForm
        action={action}
        mode="fixed"
        company={company}
        number={String(c.number)}
        date={new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw" }).format(new Date())}
        paymentDays={c.payment_days ?? company.payment_days ?? 7}
        buyerSignature={buyerSignature}
        fixedCurrency={c.currency ?? null}
        items={(c.items ?? []).map((i: { title: string; option: string; identifier?: string | null; qty?: number; price: number }) => ({ title: i.title, option: i.option, identifier: i.identifier ?? null, qty: Number(i.qty ?? 1), price: Number(i.price) }))}
      />
    </PublicShell>
  );
}
