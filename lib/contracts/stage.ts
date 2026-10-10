/**
 * Etap umowy z punktu widzenia sprzedaży: umowa „w toku” (link wysłany, czeka na zatwierdzenie albo zapłatę)
 * albo gotowa. Skany i faktury (bez szablonu) oraz umowy komisantów (rozliczane wypłatami) są gotowe od razu po przyjęciu.
 */
export type ContractLite = {
  id: string; status: string; template: string | null; paid_at: string | null; source?: string | null;
  number?: number | null; doc_number?: string | null; counterparty?: string | null; amount?: number | null; type?: string | null;
};

export type ContractStage = "sign" | "approve" | "pay" | "done" | "dead";

export function contractStage(c: Pick<ContractLite, "status" | "template" | "paid_at" | "source">): ContractStage {
  if (c.status === "cancelled" || c.status === "rejected") return "dead";
  if (c.status === "sent") return "sign";
  if (c.status === "signed") return c.template ? "approve" : "done";
  if (c.paid_at || !c.template || c.source === "consignor") return "done";
  return "pay";
}

export const STAGE_TEXT: Record<ContractStage, string> = {
  sign: "czeka na podpis",
  approve: "do zatwierdzenia",
  pay: "do opłacenia",
  done: "gotowa",
  dead: "anulowana",
};

export const CONTRACT_LITE_FIELDS = "id, status, template, paid_at, source, number, doc_number, counterparty, amount, type";
