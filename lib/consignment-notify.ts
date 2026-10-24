import "server-only";
import { allPages } from "@/lib/supabase/paging";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mailConfigured, sendMail } from "@/lib/mail";
import { getCompany } from "@/lib/contracts/settings";
import { appUrl } from "@/lib/app-url";
import { warsawMidnight } from "@/lib/month";

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const pln = (n: number | null) => (n === null ? "–" : new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN" }).format(n));
const REMIND_HOURS = 5;

type SoldUnit = {
  id: string; code: string; identifier: string | null; consignor_id: string; payout_amount: number | null; contract_id: string | null; sold_at: string | null;
  variant: { option: string; product: { title: string } } | null;
};
type Consignor = { id: string; name: string; email: string | null; phone: string | null; user_id: string | null };

const nameOf = (u: SoldUnit) => (u.variant ? `${u.variant.product.title} · ${u.variant.option}` : u.code);

function layout(company: string, body: string, button?: { href: string; label: string }) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#17232f;max-width:560px">
    <p style="margin:0 0 12px">Dzień dobry,</p>
    ${body}
    ${button ? `<p style="margin:0 0 16px"><a href="${esc(button.href)}" style="display:inline-block;background:#17232f;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px">${esc(button.label)}</a></p>
    <p style="margin:0;color:#5b6878;font-size:13px">Jeśli przycisk nie działa, wklej adres: ${esc(button.href)}</p>` : ""}
    <p style="margin:16px 0 0">Pozdrawiamy<br><b>${esc(company)}</b></p>
  </div>`;
}

/**
 * Komis po sprzedaży (co minutę z zadania cyklicznego):
 *  1. każda sprzedana rzecz komisanta bez umowy → od razu osobna umowa do podpisu (ta rzecz i jej kwota) i e-mail z linkiem;
 *  2. niepodpisana umowa → przypomnienie co 5 godzin, aż komisant ją wypełni (link przedłużany);
 *  3. raz w miesiącu (od 1. dnia) – podsumowanie rzeczy sprzedanych w poprzednim miesiącu.
 * Wystarczy e-mail komisanta – link do podpisu działa bez konta w panelu.
 */
export async function notifyConsignorSales(db: SupabaseClient) {
  if (!(await mailConfigured())) return { sent: 0, skipped: "mail" as const };
  const company = await getCompany(db);
  const base = await appUrl();
  const errors: string[] = [];
  let sent = 0;
  let reminded = 0;

  // 1. Nowe sprzedaże.
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const { data, error } = await db.from("units")
    // Tylko komisanci z e-mailem (inaczej 100 sztuk komisantów bez e-maila blokowałoby resztę na zawsze).
    .select("id, code, identifier, consignor_id, payout_amount, contract_id, sold_at, purchase_form, variant:variants(option, product:products(title)), consignor:consignors!inner(email)")
    .eq("owner_type", "consignment").in("status", ["sold", "shipped"]).is("consignor_notified_at", null)
    .gte("sold_at", since).not("consignor_id", "is", null).not("consignor.email", "is", null).neq("consignor.email", "")
    .order("sold_at", { ascending: true }).limit(100);
  if (error) throw error;
  const units = (data ?? []) as unknown as SoldUnit[];
  const consignorIds = [...new Set(units.map((u) => u.consignor_id))];
  const { data: cs } = consignorIds.length ? await db.from("consignors").select("id, name, email, phone, user_id").in("id", consignorIds) : { data: [] };
  const byId = new Map(((cs ?? []) as Consignor[]).map((c) => [c.id, c]));

  for (const u of units) {
    const c = byId.get(u.consignor_id);
    if (!c?.email) continue; // bez e-maila – poczekamy, aż komisant go dostanie
    const { data: claimed } = await db.from("units").update({ consignor_notified_at: new Date().toISOString() }).eq("id", u.id).is("consignor_notified_at", null).select("id");
    if (!claimed?.length) continue;
    const price = u.payout_amount === null ? null : Number(u.payout_amount);
    let contractId: string | null = null;
    try {
      // Komisant – podatnik VAT (forma „faktura 23%”) rozlicza się fakturą, nie umową kupna.
      const vatSeller = (u as { purchase_form?: string }).purchase_form === "vat_23";
      if (!u.contract_id && price !== null && price > 0 && !vatSeller) {
        // Umowa do podpisu z tą jedną rzeczą (jak „wypełnij umowę” w panelu komisanta).
        const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
        const items = [{ unit_id: u.id, title: u.variant?.product.title ?? u.code, option: u.variant?.option ?? "–", identifier: u.identifier, qty: 1, price: Math.round(price * 100) / 100 }];
        const { data: ct, error: ce } = await db.from("contracts").insert({
          type: "purchase", template: "purchase_v1", source: "consignor", status: "sent", currency: "PLN",
          counterparty: c.name, consignor_id: c.id, amount: items[0].price, payment_days: company.payment_days ?? 7, items,
          seller_email: c.email, seller_phone: c.phone, sign_token: token,
          sign_expires_at: new Date(Date.now() + 14 * 86400_000).toISOString(),
          notes: "Umowa wysłana komisantowi automatycznie po sprzedaży.",
        }).select("id").single();
        if (ce || !ct) throw new Error(`umowa: ${ce?.message ?? "nie zapisana"}`);
        contractId = ct.id as string;
        const { data: bound } = await db.from("units").update({ contract_id: contractId }).eq("id", u.id).is("contract_id", null).select("id");
        if (!bound?.length) { await db.from("contracts").delete().eq("id", contractId); contractId = null; }
        else {
          const link = `${base}/podpis/${token}`;
          await sendMail(c.email, `Sprzedaliśmy Twoją rzecz – podpisz umowę (${company.name})`, layout(company.name,
            `<p style="margin:0 0 12px">sprzedaliśmy Twoją rzecz z komisu:</p>
             <p style="margin:0 0 12px"><b>${esc(nameOf(u))}</b> – ${pln(price)}</p>
             <p style="margin:0 0 14px">Aby rozliczyć sprzedaż, <b>wypełnij i podpisz umowę</b> – dane rzeczy i kwota są już wpisane.</p>`,
            { href: link, label: "Wypełnij i podpisz umowę" }));
          // Zdarzenie dopiero po wysłaniu (przy błędzie umowa jest cofana).
          await db.from("unit_events").insert({ unit_id: u.id, type: "contract", data: { contract_id: contractId, note: "umowa do podpisu wysłana komisantowi po sprzedaży" } });
          sent++;
          continue;
        }
      }
      // Rzecz ma już dokument albo nie ma ustalonej kwoty – tylko informacja.
      await sendMail(c.email, `Sprzedaliśmy Twoją rzecz z komisu – ${company.name}`, layout(company.name,
        `<p style="margin:0 0 12px">sprzedaliśmy Twoją rzecz z komisu: <b>${esc(nameOf(u))}</b>${price ? ` – ${pln(price)}` : ""}.</p>
         <p style="margin:0 0 14px">${vatSeller && !u.contract_id ? "Do rozliczenia potrzebujemy Twojej faktury – wgrasz ją w panelu komisanta (Sprzedane → Dołącz umowę / fakturę)." : price ? "Szczegóły i kwotę do wypłaty zobaczysz w panelu komisanta." : "Skontaktujemy się w sprawie kwoty do wypłaty."}</p>`,
        c.user_id ? { href: `${base}/komis?zakladka=sprzedane`, label: "Otwórz panel" } : undefined));
      sent++;
    } catch (e) {
      // Nie wyszło – cofamy umowę i znacznik; spróbujemy przy następnym uruchomieniu.
      if (contractId) {
        await db.from("units").update({ contract_id: null }).eq("id", u.id).eq("contract_id", contractId);
        await db.from("contracts").delete().eq("id", contractId);
      }
      await db.from("units").update({ consignor_notified_at: null }).eq("id", u.id);
      errors.push(`${c.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 2. Przypomnienia co 5 godzin o niepodpisanej umowie (także tej zaczętej w panelu).
  const cutoff = new Date(Date.now() - REMIND_HOURS * 3600_000).toISOString();
  const { data: pending, error: pe } = await db.from("contracts")
    .select("id, sign_token, seller_email, created_at, reminded_at, items, amount, consignor:consignors(name, email)")
    .eq("source", "consignor").eq("status", "sent").not("sign_token", "is", null).lt("created_at", cutoff)
    .or(`reminded_at.is.null,reminded_at.lt.${cutoff}`).limit(50);
  if (pe && !/reminded_at/.test(pe.message)) errors.push(`przypomnienia: ${pe.message}`);
  // Bez przypomnień, gdy rzecz z umowy wróciła (zwrot / anulowanie) – żadna z jej sztuk nie jest już sprzedana.
  const pendingIds = (pending ?? []).map((p) => p.id as string);
  const { data: bound } = pendingIds.length ? await db.from("units").select("contract_id, status").in("contract_id", pendingIds) : { data: [] };
  const stale = new Set<string>();
  for (const id of pendingIds) {
    const us = (bound ?? []).filter((b) => b.contract_id === id);
    if (us.length && !us.some((b) => ["sold", "shipped"].includes(b.status as string))) stale.add(id);
  }
  // Odkładamy je o kolejne 5 godzin, żeby nie zajmowały miejsca w następnych przebiegach.
  if (stale.size) await db.from("contracts").update({ reminded_at: new Date().toISOString() }).in("id", [...stale]);
  for (const p of pending ?? []) {
    if (stale.has(p.id as string)) continue;
    const cons = p.consignor as unknown as { name: string; email: string | null } | null;
    const to = (p.seller_email as string | null) || cons?.email;
    if (!to) continue;
    // Najpierw znacznik (podwójne uruchomienie nie wyśle dwa razy) i przedłużenie linku.
    const { data: mark } = await db.from("contracts").update({ reminded_at: new Date().toISOString(), sign_expires_at: new Date(Date.now() + 14 * 86400_000).toISOString() })
      .eq("id", p.id).eq("status", "sent").or(`reminded_at.is.null,reminded_at.lt.${cutoff}`).select("id");
    if (!mark?.length) continue;
    const items = (p.items ?? []) as { title: string; option?: string; price?: number }[];
    try {
      await sendMail(to, `Przypomnienie: podpisz umowę do sprzedanej rzeczy – ${company.name}`, layout(company.name,
        `<p style="margin:0 0 12px">przypominamy o umowie do Twojej sprzedanej rzeczy z komisu:</p>
         <ul style="margin:0 0 12px;padding-left:18px">${items.map((i) => `<li>${esc(`${i.title}${i.option && i.option !== "–" ? ` · ${i.option}` : ""}`)}${i.price ? ` – ${pln(Number(i.price))}` : ""}</li>`).join("")}</ul>
         <p style="margin:0 0 14px">Bez podpisanej umowy nie możemy rozliczyć wypłaty. Wypełnienie zajmuje minutę.</p>`,
        { href: `${base}/podpis/${p.sign_token}`, label: "Wypełnij i podpisz umowę" }));
      reminded++;
    } catch (e) {
      await db.from("contracts").update({ reminded_at: p.reminded_at }).eq("id", p.id);
      errors.push(`przypomnienie: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 3. Podsumowanie miesiąca (raz, od 1. dnia następnego miesiąca).
  const monthly = await monthlySummary(db, company.name, base).catch((e) => { errors.push(`podsumowanie: ${e instanceof Error ? e.message : String(e)}`); return 0; });

  return { sent, reminded, monthly, ...(errors.length ? { errors } : {}) };
}

/** Podsumowanie poprzedniego miesiąca: sprzedane rzeczy komisanta, kwoty i stan rozliczenia (po 20 komisantów na przebieg). */
async function monthlySummary(db: SupabaseClient, company: string, base: string) {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Warsaw" }));
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const key = `consignor_monthly:${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}`;
  const { data: st } = await db.from("sync_state").select("value").eq("key", key).maybeSingle();
  const state = (st?.value as { done?: string[]; finished?: boolean } | null) ?? { done: [] };
  if (state.finished) return 0;
  // Tylko w pierwszym tygodniu miesiąca – po wdrożeniu w połowie miesiąca nie wysyłamy zaległego podsumowania.
  if (now.getDate() > 7) {
    await db.from("sync_state").upsert({ key, value: { ...state, finished: true }, updated_at: new Date().toISOString() });
    return 0;
  }
  const from = warsawMidnight(prev.getFullYear(), prev.getMonth() + 1, 1).toISOString();
  const to = warsawMidnight(now.getFullYear(), now.getMonth() + 1, 1).toISOString();
  const units = await allPages((a, b) => db.from("units")
    .select("id, code, consignor_id, payout_amount, contract_id, consignor_payout_id, sold_at, variant:variants(option, product:products(title)), contract:contracts(status)")
    .eq("owner_type", "consignment").in("status", ["sold", "shipped"]).gte("sold_at", from).lt("sold_at", to).not("consignor_id", "is", null)
    .order("id").range(a, b));
  const list = (units ?? []) as unknown as (SoldUnit & { consignor_payout_id?: string | null; contract: { status: string } | null })[];
  const ids = [...new Set(list.map((u) => u.consignor_id))].filter((id) => !(state.done ?? []).includes(id));
  if (!ids.length) {
    await db.from("sync_state").upsert({ key, value: { ...state, finished: true }, updated_at: new Date().toISOString() });
    return 0;
  }
  const { data: cs } = await db.from("consignors").select("id, name, email, user_id").in("id", ids.slice(0, 20));
  const monthName = prev.toLocaleDateString("pl-PL", { month: "long", year: "numeric" });
  let n = 0;
  for (const c of (cs ?? []) as Consignor[]) {
    state.done = [...(state.done ?? []), c.id];
    if (!c.email) continue;
    const mine = list.filter((u) => u.consignor_id === c.id);
    const total = mine.reduce((s, u) => s + Number(u.payout_amount ?? 0), 0);
    const statusOf = (u: (typeof mine)[number]) => (u.consignor_payout_id ? "wypłacone" : !u.contract_id ? "czeka na umowę" : u.contract?.status === "sent" ? "czeka na podpis umowy" : "do wypłaty");
    const rows = mine.map((u) => `<tr><td style="padding:4px 8px 4px 0">${esc(nameOf(u))}</td><td style="padding:4px 8px;text-align:right;white-space:nowrap">${pln(u.payout_amount === null ? null : Number(u.payout_amount))}</td><td style="padding:4px 0;color:#5b6878">${statusOf(u)}</td></tr>`).join("");
    try {
      await sendMail(c.email, `Podsumowanie sprzedaży z komisu – ${monthName}`, layout(company,
        `<p style="margin:0 0 12px">w miesiącu <b>${esc(monthName)}</b> sprzedaliśmy ${mine.length === 1 ? "Twoją rzecz" : `${mine.length} Twoich rzeczy`} z komisu:</p>
         <table style="border-collapse:collapse;margin:0 0 10px;font-size:14px">${rows}</table>
         <p style="margin:0 0 14px">Razem: <b>${pln(Math.round(total * 100) / 100)}</b></p>`,
        c.user_id ? { href: `${base}/komis?zakladka=sprzedane`, label: "Otwórz panel komisanta" } : undefined));
      n++;
    } catch {
      state.done = (state.done ?? []).filter((x) => x !== c.id); // spróbujemy przy kolejnym przebiegu
    }
  }
  await db.from("sync_state").upsert({ key, value: state, updated_at: new Date().toISOString() });
  return n;
}
