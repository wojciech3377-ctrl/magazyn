import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mailConfigured, sendMail } from "@/lib/mail";
import { appUrl } from "@/lib/app-url";
import { getCompany } from "@/lib/contracts/settings";
import { escapeHtml as esc } from "@/lib/contracts/png";

function layout(body: string, href: string) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#17232f;max-width:560px">
    <p style="margin:0 0 12px">Dzień dobry,</p>
    ${body}
    <p style="margin:0 0 16px"><a href="${esc(href)}" style="display:inline-block;background:#17232f;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px">Zaloguj się</a></p>
    <p style="margin:0;color:#5b6878;font-size:13px">Jeśli przycisk nie działa, wklej adres: ${esc(href)}</p>
  </div>`;
}

/**
 * E-mail do pracownika: nowe konto albo nowe hasło tymczasowe. Hasło startowe działa tylko do pierwszego logowania –
 * aplikacja od razu prosi o ustawienie własnego. Zwraca opis wyniku do komunikatu (bez rzucania błędu).
 */
export async function mailStaffAccount(db: SupabaseClient, kind: "new" | "reset" | "linked", to: string, password: string | null, name?: string | null) {
  try {
    if (!(await mailConfigured())) return "E-mail nie wysłany – poczta nie jest ustawiona (Ustawienia → Faktury i KSeF → SMTP). Przekaż dane osobiście.";
    const [company, base] = await Promise.all([getCompany(db), appUrl()]);
    const login = `${base}/login`;
    const who = name ? `<p style="margin:0 0 12px">${esc(name)},</p>` : "";
    const creds = `<p style="margin:0 0 12px">Login: <b>${esc(to)}</b>${password ? `<br>Hasło tymczasowe: <b style="font-family:monospace">${esc(password)}</b>` : ""}</p>`;
    const body = kind === "new"
      ? `${who}<p style="margin:0 0 12px">założyliśmy Ci konto w aplikacji magazynowej ${esc(company.name)}.</p>${creds}
         <p style="margin:0 0 14px">Przy pierwszym logowaniu aplikacja poprosi o ustawienie własnego hasła – hasło tymczasowe przestanie wtedy działać.</p>`
      : kind === "reset"
      ? `${who}<p style="margin:0 0 12px">ustawiliśmy Ci nowe hasło tymczasowe do aplikacji magazynowej ${esc(company.name)}.</p>${creds}
         <p style="margin:0 0 14px">Po zalogowaniu aplikacja poprosi o ustawienie własnego hasła.</p>`
      : `${who}<p style="margin:0 0 12px">Twoje konto (${esc(to)}) dostało dostęp pracownika w aplikacji magazynowej ${esc(company.name)}. Logujesz się dotychczasowym hasłem.</p>`;
    await sendMail(to, kind === "reset" ? `Nowe hasło tymczasowe – ${company.name}` : `Konto w aplikacji – ${company.name}`, layout(body, login));
    return `E-mail z danymi logowania wysłany na ${to}.`;
  } catch (e) {
    return `E-mail nie wysłany (${e instanceof Error ? e.message : String(e)}) – przekaż dane osobiście.`;
  }
}
