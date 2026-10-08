import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getBuyerSignature, getCompany } from "./settings";
import { toPurchaseContract, type ContractRow } from "./build";
import { purchaseBlocks } from "./purchase";
import { renderContractPdf } from "./pdf";

/** PDF umowy z bazy (podpisany albo szkic do podglądu). */
export async function contractPdf(db: SupabaseClient, c: ContractRow & { seller_signature?: string | null; signed_at?: string | null; signer_ip?: string | null }) {
  const [company, buyerSignature] = await Promise.all([getCompany(db), getBuyerSignature(db)]);
  const data = toPurchaseContract(c, company);
  const signedNote = c.signed_at
    ? `Podpisano elektronicznie przez Sprzedającego ${new Intl.DateTimeFormat("pl-PL", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Warsaw" }).format(new Date(c.signed_at))}${c.signer_ip ? `, adres IP ${c.signer_ip}` : ""}.`
    : null;
  return renderContractPdf(purchaseBlocks(data), {
    title: `Umowa kupna nr ${data.number}`,
    buyerSignature,
    sellerSignature: c.seller_signature ?? null,
    signedNote,
  });
}
