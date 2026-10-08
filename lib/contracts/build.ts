import type { Company, ContractItem, PurchaseContract } from "./purchase";

export type ContractRow = {
  id: string;
  number: number | null;
  contract_date: string | null;
  created_at: string;
  seller_name: string | null;
  seller_id_number: string | null;
  seller_address: string | null;
  seller_bank_account: string | null;
  payment_days: number | null;
  payment_method?: "transfer" | "cash" | null;
  currency?: string | null;
  seller_country?: string | null;
  items: (ContractItem & { unit_id?: string; variant_id?: string })[] | null;
};

/** Dane do treści umowy z wiersza bazy; puste pola sprzedającego jako kreski (podgląd przed wypełnieniem). */
export function toPurchaseContract(c: ContractRow, company: Company, sellerOverride?: Partial<PurchaseContract["seller"]>): PurchaseContract {
  const dash = "…………………";
  return {
    number: c.number ?? "",
    date: c.contract_date ?? c.created_at.slice(0, 10),
    company,
    seller: {
      name: sellerOverride?.name || c.seller_name || dash,
      idNumber: sellerOverride?.idNumber || c.seller_id_number || dash,
      address: sellerOverride?.address || c.seller_address || dash,
      bankAccount: sellerOverride?.bankAccount || c.seller_bank_account || dash,
      country: c.seller_country ?? null,
    },
    paymentMethod: c.payment_method ?? null,
    currency: c.currency ?? null,
    items: (c.items ?? []).map((i) => ({ title: i.title, option: i.option, identifier: i.identifier ?? null, qty: Number(i.qty ?? 1), price: Number(i.price) })),
    paymentDays: c.payment_days ?? company.payment_days ?? 7,
  };
}
