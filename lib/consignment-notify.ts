import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mailConfigured, sendMail } from "@/lib/mail";
import { getCompany } from "@/lib/contracts/settings";
import { appUrl } from "@/lib/app-url";

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const pln = (n: number | null) => (n === null ? "–" : new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN" }).format(n));

type SoldUnit = {
  id: string; code: string; consignor_id: string; payout_amount: number | null; contract_id: string | null; sold_at: string | null;
  variant: { option: string; product: { title: string } } | null;
};

/**
 * E-mail do komisanta, gdy jego rzecz się sprzeda: lista rzeczy i link do panelu, gdzie wypełni umowę
 * albo wgra fakturę. Raz na rzecz (units.consignor_notified_at); tylko komisanci z kontem i e-mailem,
 * tylko sprzedaż z ostatnich 30 dni.
 */
export async function notifyConsignorSales(db: SupabaseClient) {
  if (!(await mailConfigured())) return { sent: 0, skipped: "mail" as const };
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const { data, error } = await db.from("units")
    .select("id, code, consignor_id, payout_amount, contract_id, sold_at, variant:variants(option, product:products(title))")
    .eq("owner_type", "consignment").in("status", ["sold", "shipped"]).is("consignor_notified_at", null)
    .gte("sold_at", since).not("consignor_id", "is", null).limit(300);
  if (error) throw error;
  const units = (data ?? []) as unknown as SoldUnit[];
  if (!units.length) return { sent: 0 };

  const consignorIds = [...new Set(units.map((u) => u.consignor_id))];
  const { data: consignors } = await db.from("consignors").select("id, name, email, user_id").in("id", consignorIds);
  const company = await getCompany(db);
  const link = `${await appUrl()}/komis?zakladka=sprzedane`;
  let sent = 0;
  const errors: string[] = [];

  for (const c of consignors ?? []) {
    if (!c.email || !c.user_id) continue; // bez konta link do panelu nic nie da – poczekamy, aż konto powstanie
    const mine = units.filter((u) => u.consignor_id === c.id).map((u) => u.id);
    // Blokada przed podwójną wysyłką (dwa uruchomienia jednocześnie).
    const { data: claimed } = await db.from("units").update({ consignor_notified_at: new Date().toISOString() })
      .in("id", mine).is("consignor_notified_at", null).select("id");
    const ids = new Set((claimed ?? []).map((u) => u.id as string));
    const list = units.filter((u) => ids.has(u.id));
    if (!list.length) continue;
    const missing = list.filter((u) => !u.contract_id);
    const rows = list.map((u) => `<tr><td style="padding:4px 8px 4px 0">${esc(u.variant ? `${u.variant.product.title} · ${u.variant.option}` : u.code)}</td><td style="padding:4px 0;text-align:right;white-space:nowrap">${pln(u.payout_amount === null ? null : Number(u.payout_amount))}</td></tr>`).join("");
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#17232f;max-width:560px">
      <p style="margin:0 0 12px">Dzień dobry,</p>
      <p style="margin:0 0 12px">${list.length === 1 ? "sprzedaliśmy Twoją rzecz z komisu" : `sprzedaliśmy Twoje rzeczy z komisu (${list.length} szt.)`}:</p>
      <table style="border-collapse:collapse;margin:0 0 14px;font-size:14px">${rows}</table>
      ${missing.length ? `<p style="margin:0 0 14px">Aby rozliczyć sprzedaż, w panelu komisanta (zakładka „Sprzedane”) <b>wypełnij i podpisz umowę</b> albo <b>wgraj swoją fakturę</b>.</p>` : `<p style="margin:0 0 14px">Szczegóły i kwotę do wypłaty zobaczysz w panelu komisanta.</p>`}
      <p style="margin:0 0 16px"><a href="${esc(link)}" style="display:inline-block;background:#17232f;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px">${missing.length ? "Dołącz umowę lub fakturę" : "Otwórz panel"}</a></p>
      <p style="margin:0;color:#5b6878;font-size:13px">Jeśli przycisk nie działa, wklej adres: ${esc(link)}</p>
      <p style="margin:16px 0 0">Pozdrawiamy<br><b>${esc(company.name)}</b></p>
    </div>`;
    try {
      await sendMail(c.email, `Sprzedaliśmy Twoje rzeczy z komisu – ${company.name}`, html);
      sent++;
    } catch (e) {
      // Nie wyszło – zdejmujemy znacznik, spróbujemy przy następnym uruchomieniu.
      await db.from("units").update({ consignor_notified_at: null }).in("id", [...ids]);
      errors.push(`${c.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { sent, ...(errors.length ? { errors } : {}) };
}
