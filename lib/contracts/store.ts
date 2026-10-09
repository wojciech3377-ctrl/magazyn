import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { contractPdf } from "./sign";
import { getCompany } from "./settings";
import { contractTotal, formatMoney } from "./purchase";
import { escapeHtml } from "./png";
import { mailConfigured, sendMail } from "@/lib/mail";
import { errorMessage } from "@/lib/errors";

async function logError(db: SupabaseClient, job: string, id: string, e: unknown) {
  await db.from("sync_log").insert({ job, ok: false, message: `${id}: ${errorMessage(e)}` });
}

/** Sprzedający podpisał – e-mail do sklepu, że umowa czeka na zatwierdzenie (jeśli SMTP jest ustawiony). */
export async function notifyAwaitingApproval(contractId: string) {
  const db = createAdminClient();
  try {
    if (!mailConfigured()) return;
    const { data: c } = await db.from("contracts").select("*").eq("id", contractId).single();
    const company = await getCompany(db);
    await sendMail(company.email, `Umowa kupna nr ${c.number} czeka na zatwierdzenie`,
      `<p>${escapeHtml(c.seller_name)} podpisał(a) umowę kupna nr ${c.number} na kwotę ${escapeHtml(formatMoney(contractTotal(c.items ?? []), c.currency))}.</p>` +
      `<p>Zatwierdź ją w aplikacji w zakładce Umowy – dopiero wtedy sprzedający dostanie umowę z Waszym podpisem.</p>`);
  } catch (e) {
    await logError(db, "contract-mail", contractId, e);
  }
}

/** PDF zatwierdzonej umowy (z oboma podpisami); gdy go brak – generuje i zapisuje. */
export async function ensureContractPdf(contractId: string): Promise<Buffer | null> {
  const db = createAdminClient();
  const { data: c } = await db.from("contracts").select("*").eq("id", contractId).single();
  if (!c || c.status !== "accepted") return null;
  if (c.file_path) {
    const { data } = await db.storage.from("contracts").download(c.file_path);
    if (data) return Buffer.from(await data.arrayBuffer());
  }
  const pdf = Buffer.from(await contractPdf(db, c));
  const now = new Date();
  const path = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${crypto.randomUUID()}.pdf`;
  const { error } = await db.storage.from("contracts").upload(path, pdf, { contentType: "application/pdf" });
  if (error) throw new Error(`Nie udało się zapisać PDF: ${error.message}`);
  await db.from("contracts").update({ file_path: path, file_name: `umowa-kupna-${c.number}.pdf` }).eq("id", contractId);
  return pdf;
}

/** Po zatwierdzeniu: PDF z oboma podpisami do Storage i kopia e-mailem do sprzedającego (jeśli podał e-mail). */
export async function deliverAcceptedContract(contractId: string): Promise<{ emailed: boolean; error?: string }> {
  const db = createAdminClient();
  try {
    const pdf = await ensureContractPdf(contractId);
    if (!pdf) return { emailed: false, error: "Umowa nie jest zatwierdzona." };
    const { data: c } = await db.from("contracts").select("number, seller_email").eq("id", contractId).single();
    if (!c?.seller_email || !mailConfigured()) return { emailed: false };
    const company = await getCompany(db);
    await sendMail(c.seller_email, `Umowa kupna nr ${c.number} – ${company.name}`,
      `<p>Dziękujemy! W załączniku umowa kupna nr ${c.number} podpisana przez obie strony.</p><p>${escapeHtml(company.name)}</p>`,
      [{ filename: `umowa-kupna-${c.number}.pdf`, content: pdf }]);
    return { emailed: true };
  } catch (e) {
    await logError(db, "contract-pdf", contractId, e);
    return { emailed: false, error: errorMessage(e) };
  }
}
