/**
 * Etap umowy z punktu widzenia sprzedaży: umowa „w toku” (link wysłany, czeka na zatwierdzenie albo zapłatę)
 * albo gotowa. Skany i faktury (bez szablonu) oraz umowy komisantów (rozliczane wypłatami) są gotowe od razu po przyjęciu.
 */
export type ContractLite = {
  id: string; status: string; template: string | null; paid_at: string | null; source?: string | null;
  number?: number | null; doc_number?: string | null; counterparty?: string | null; amount?: number | null; type?: string | null; currency?: string | null;
};

export type ContractStage = "sign" | "approve" | "offer" | "pay" | "done" | "dead";

export function contractStage(c: Pick<ContractLite, "status" | "template" | "paid_at" | "source">): ContractStage {
  if (c.status === "cancelled" || c.status === "rejected") return "dead";
  if (c.status === "sent") return "sign";
  if (c.status === "offer") return "offer"; // nasza oferta cenowa czeka na odpowiedź sprzedającego
  if (c.status === "signed") return "approve"; // podpisana z linku albo faktura komisanta – czeka na nasze zatwierdzenie
  if (c.paid_at || !c.template || c.source === "consignor") return "done";
  return "pay";
}

export const STAGE_TEXT: Record<ContractStage, string> = {
  sign: "czeka na podpis",
  approve: "do zatwierdzenia",
  offer: "oferta – czeka na odpowiedź",
  pay: "do opłacenia",
  done: "gotowa",
  dead: "anulowana",
};

/** Kolor przy sprzedaży / w magazynie: zielony = umowa jest (także nieopłacona), pomarańczowy = w toku. */
export const isSettled = (s: ContractStage | null) => s === "done" || s === "pay";

/** Przycisk „Dołącz umowę” (brak umowy) – na czerwono. */
export const MISSING_BTN = "inline-flex items-center justify-center whitespace-nowrap rounded-md border border-bad/40 bg-rose-50 px-2.5 py-1 text-xs font-medium text-bad hover:bg-rose-100";

export const CONTRACT_LITE_FIELDS = "id, status, template, paid_at, source, number, doc_number, counterparty, amount, type, currency";
