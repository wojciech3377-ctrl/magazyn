import { headers } from "next/headers";
import type { Company } from "@/lib/contracts/purchase";
import { SubmitButton } from "@/components/SubmitButton";
import { SignaturePad } from "@/components/SignaturePad";
import { CopyLink } from "@/app/(app)/umowy/[id]/CopyLink";
import { saveBuyerSignature, saveCompany, updateGeneralLink } from "./actions";

export async function ContractSettings({ company, signature, general }: { company: Company; signature: string | null; general: { key?: string; enabled?: boolean } | null }) {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const link = general?.key ? `${host.startsWith("localhost") ? "http" : "https"}://${host}/umowa/${general.key}` : "";
  return (
    <section className="card space-y-5 p-4">
      <h2 className="h2">Umowy kupna</h2>
      <div className="grid gap-5 lg:grid-cols-2">
        <form action={saveCompany} className="space-y-2">
          <h3 className="font-medium">Kupujący na umowie</h3>
          <input className="input" name="name" defaultValue={company.name} aria-label="Nazwa firmy" />
          <div className="grid grid-cols-2 gap-2">
            <input className="input" name="street" defaultValue={company.street} aria-label="Ulica" />
            <input className="input" name="city" defaultValue={company.city} aria-label="Kod i miasto" />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <input className="input" name="nip" defaultValue={company.nip} aria-label="NIP" />
            <input className="input col-span-2" name="email" defaultValue={company.email} aria-label="E-mail do umów" />
          </div>
          <label className="flex items-center gap-2 text-sm">Przelew w ciągu <input className="input w-20" name="payment_days" type="number" defaultValue={company.payment_days ?? 7} /> dni</label>
          <SubmitButton className="btn-secondary">Zapisz dane firmy</SubmitButton>
        </form>
        <form action={saveBuyerSignature} className="space-y-2">
          <h3 className="font-medium">Podpis kupującego</h3>
          {signature ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={signature} alt="Zapisany podpis" className="h-20 rounded border border-line bg-white p-1" />
          ) : <p className="text-sm text-warn">Brak podpisu – umowy będą bez podpisu kupującego.</p>}
          <SignaturePad label={signature ? "Nowy podpis (zastąpi obecny)" : "Podpis"} />
          <SubmitButton className="btn-secondary">Zapisz podpis</SubmitButton>
        </form>
      </div>
      <div className="space-y-2 border-t border-line pt-4">
        <h3 className="font-medium">Ogólny link do umowy</h3>
        <p className="text-sm text-muted">Dla klientów, którzy sami wpisują, co sprzedają (np. na stronie skupu albo w wiadomości). Podpisane umowy trafiają do zakładki Umowy – tam przypisujesz je do katalogu.</p>
        {general?.enabled && link ? <CopyLink link={link} /> : <p className="text-sm text-warn">Link jest wyłączony.</p>}
        <form action={updateGeneralLink} className="flex flex-wrap gap-2">
          {general?.enabled
            ? <SubmitButton className="btn-secondary" name="op" value="disable">Wyłącz link</SubmitButton>
            : <SubmitButton className="btn-secondary" name="op" value="enable">Włącz link</SubmitButton>}
          <SubmitButton className="btn-secondary" name="op" value="regenerate">Utwórz nowy link (stary przestanie działać)</SubmitButton>
        </form>
      </div>
    </section>
  );
}
