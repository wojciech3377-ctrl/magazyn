import type { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCompany } from "@/lib/contracts/settings";
import { formatMoney } from "@/lib/contracts/purchase";
import { respondContractOffer } from "../../actions";
import { PublicShell } from "../../PublicShell";
import { OfferResponse } from "./OfferResponse";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Propozycja ceny", robots: { index: false, follow: false } };

/** Nasza oferta cenowa do podpisanej umowy: sprzedający akceptuje (podpis) albo odrzuca. */
export default async function OfferPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const db = createAdminClient();
  const company = await getCompany(db);
  const { data: c } = /^[a-f0-9]{32,64}$/.test(token)
    ? await db.from("contracts").select("id, number, status, items, offer, currency, sign_expires_at, offer_responded_at").eq("sign_token", token).maybeSingle()
    : { data: null };
  const shell = (body: React.ReactNode) => <PublicShell company={company.name}><div className="card mx-auto max-w-lg space-y-3 p-6">{body}</div></PublicShell>;
  if (!c || (!c.offer && c.status !== "offer")) return shell(<p>Ten link jest nieaktywny. Skontaktuj się z nami: {company.email}</p>);
  if (c.status === "accepted" && c.offer_responded_at) {
    return shell(<>
      <h1 className="h1">Dziękujemy – umowa NR{c.number} jest zawarta</h1>
      <p className="text-sm text-muted">Zaakceptowałeś(-aś) nowe ceny. Umowę z podpisami obu stron pobierzesz tutaj{" "}<a className="text-accent underline" href={`/podpis/pdf/${token}`}>(PDF)</a>.</p>
    </>);
  }
  if (c.status === "rejected") return shell(<><h1 className="h1">Oferta odrzucona</h1><p className="text-sm text-muted">Umowa NR{c.number} nie zostanie zawarta. W razie pytań: {company.email}</p></>);
  if (c.status !== "offer") return shell(<p>Ta oferta nie czeka już na odpowiedź. Kontakt: {company.email}</p>);
  if (c.sign_expires_at && new Date(c.sign_expires_at) < new Date()) return shell(<p>Oferta wygasła. Skontaktuj się z nami: {company.email}</p>);

  const items = (c.items ?? []) as { title: string; option: string; qty: number; price: number }[];
  const offer = (c.offer ?? {}) as { prices?: number[]; note?: string | null };
  const cur = c.currency ?? "PLN";
  const rows = items.map((it, idx) => ({ title: `${it.title} ${it.option ?? ""}`.trim(), qty: Number(it.qty ?? 1), before: formatMoney(Number(it.price), cur), after: formatMoney(Number(offer.prices?.[idx] ?? it.price), cur), changed: Number(offer.prices?.[idx] ?? it.price) !== Number(it.price) }));
  const total = formatMoney(items.reduce((s, it, idx) => s + Number(it.qty ?? 1) * Number(offer.prices?.[idx] ?? it.price), 0), cur);
  return (
    <PublicShell company={company.name}>
      <h1 className="h1 mb-3">Umowa NR{c.number}: nasza propozycja ceny</h1>
      <OfferResponse action={respondContractOffer.bind(null, token)} rows={rows} total={total} note={offer.note ?? null} />
    </PublicShell>
  );
}
