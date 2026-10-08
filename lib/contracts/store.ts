import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { contractPdf } from "./sign";
import { getCompany } from "./settings";
import { contractTotal, formatPln } from "./purchase";
import { escapeHtml } from "./png";
import { mailConfigured, sendMail } from "@/lib/mail";

/** PDF do Storage + powiadomienia e-mail (jeśli SMTP jest ustawiony). Błędy tylko do dziennika – umowa jest już podpisana. */
export async function storePdfAndNotify(contractId: string, opts: { emailSeller: boolean }) {
  const db = createAdminClient();
  try {
    const { data: c } = await db.from("contracts").select("*").eq("id", contractId).single();
    const pdf = await ensureContractPdf(contractId);
    if (!pdf || !mailConfigured()) return;
    const company = await getCompany(db);
    const total = formatPln(contractTotal(c.items ?? []));
    const filename = `umowa-kupna-${c.number}.pdf`;
    await sendMail(company.email, `Podpisana umowa kupna nr ${c.number}`,
      `<p>${escapeHtml(c.seller_name)} podpisał(a) umowę kupna nr ${c.number} na kwotę ${escapeHtml(total)}.</p><p>Umowa jest w aplikacji w zakładce Umowy.</p>`,
      [{ filename, content: pdf }]);
    if (opts.emailSeller && c.seller_email) {
      await sendMail(c.seller_email, `Umowa kupna nr ${c.number} – ${company.name}`,
        `<p>Dziękujemy! W załączniku kopia podpisanej umowy kupna nr ${c.number}.</p><p>${escapeHtml(company.name)}</p>`,
        [{ filename, content: pdf }]);
    }
  } catch (e) {
    await db.from("sync_log").insert({ job: "contract-pdf", ok: false, message: `${contractId}: ${e instanceof Error ? e.message : String(e)}` });
  }
}

/** Zapisany PDF podpisanej umowy; gdy go brak – generuje i zapisuje. */
export async function ensureContractPdf(contractId: string): Promise<Buffer | null> {
  const db = createAdminClient();
  const { data: c } = await db.from("contracts").select("*").eq("id", contractId).single();
  if (!c || c.status !== "signed") return null;
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

