import { createAdminClient } from "@/lib/supabase/admin";
import { getFiscalSettings, JOB_STATUS, PTU_LETTERS, ptuLabel } from "@/lib/fiscal/jobs";
import { dateTime, money } from "@/lib/labels";
import { Notice, Pill } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { ConfirmSubmit } from "@/components/ConfirmSubmit";
import { AddPrinterForm, RegenerateKeyForm } from "./PrinterKeyForms";
import { deletePrinter, fixReceiptNumber, saveFiscalSettings, testPrinter, togglePrinter } from "./fiscal-actions";

/** Wersja programu „Drukarka Magazyn” w agent/drukarka (0.3.0: numer wydruku z treści paragonu). */
const AGENT_VERSION = "0.3.0";

type Printer = { id: string; name: string; active: boolean; last_seen_at: string | null; last_status: Record<string, string> | null; created_at: string };
type Job = { id: string; number: number; source: string; status: string; total: number; receipt_number: string | null; error: string | null; created_at: string; pos_order_id: string | null; order_id: string | null; printer: { name: string } | null };

/** Ustawienia → Drukarka fiskalna: drukarki (program na Windows), stawki PTU i ostatnie paragony z kolejki. */
export async function FiscalSettings() {
  const db = createAdminClient();
  const [printersRes, jobsRes, settings] = await Promise.all([
    db.from("fiscal_printers").select("id, name, active, last_seen_at, last_status, created_at").order("created_at"),
    db.from("receipt_jobs").select("id, number, source, status, total, receipt_number, error, created_at, pos_order_id, order_id, printer:fiscal_printers(name)").order("created_at", { ascending: false }).limit(30),
    getFiscalSettings(db),
  ]);
  if (printersRes.error) return <Notice tone="error">Uruchom migrację 0036 w Supabase (SQL Editor) – wtedy pojawi się tu drukarka fiskalna.</Notice>;
  const printers = (printersRes.data ?? []) as Printer[];
  const jobs = (jobsRes.data ?? []) as unknown as Job[];
  const online = (p: Printer) => !!p.last_seen_at && Date.now() - new Date(p.last_seen_at).getTime() < 3 * 60_000;

  return (
    <div className="space-y-5">
      <section className="card space-y-4 p-5">
        <div>
          <h2 className="h2">Drukarka fiskalna</h2>
          <p className="mt-1 text-sm text-muted">
            Paragony z Kasy („Zakończ i wystaw paragon”) i z zamówień („Drukuj paragon”) trafiają do kolejki. Program „Drukarka Magazyn” na komputerze z Windows
            przy drukarce pobiera je co 2 sekundy, drukuje i odsyła numer paragonu. Obsługuje drukarki ELZAB (np. Zeta Online) przez sieć (Wi‑Fi / kabel) albo port COM.
          </p>
        </div>
        <ol className="grid gap-3 text-sm md:grid-cols-3">
          <li className="rounded-xl border border-line bg-slate-50/60 p-3"><b className="mb-1 block">1. Dodaj drukarkę</b>Nadaj nazwę i skopiuj klucz – pokaże się tylko raz.</li>
          <li className="rounded-xl border border-line bg-slate-50/60 p-3"><b className="mb-1 block">2. Zainstaluj program</b><a className="font-medium text-accent hover:underline" href="/api/program-drukarki">Pobierz DrukarkaMagazyn.zip</a>, rozpakuj na komputerze przy drukarce i uruchom <span className="font-mono">Zainstaluj.bat</span>.</li>
          <li className="rounded-xl border border-line bg-slate-50/60 p-3"><b className="mb-1 block">3. Sprawdź połączenie</b>Po minucie drukarka pokaże się tu jako połączona. „Sprawdź połączenie” niczego nie drukuje.</li>
        </ol>
        <AddPrinterForm />
        {printers.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="table">
              <thead><tr><th>Drukarka</th><th>Program</th><th>Połączenie z drukarką</th><th /></tr></thead>
              <tbody>
                {printers.map((p) => (
                  <tr key={p.id}>
                    <td className="font-medium">{p.name}{!p.active && <span className="ml-2"><Pill>wyłączona</Pill></span>}</td>
                    <td className="text-sm">
                      {online(p) ? <Pill tone="green">połączony</Pill> : p.last_seen_at ? <Pill tone="red">brak kontaktu</Pill> : <Pill tone="amber">jeszcze nie zainstalowany</Pill>}
                      {p.last_seen_at && <span className="block text-xs text-muted">ostatnio {dateTime(p.last_seen_at)}{p.last_status?.komputer ? ` · ${p.last_status.komputer}` : ""}{p.last_status?.wersja ? ` · v${p.last_status.wersja}` : ""}</span>}
                      {p.last_status?.wersja && p.last_status.wersja < AGENT_VERSION && <span className="mt-1 block text-xs font-medium text-warn">Jest nowa wersja programu – <a className="underline" href="/api/program-drukarki">pobierz</a> i uruchom Zainstaluj.bat ponownie.</span>}
                    </td>
                    <td className="text-sm">
                      {p.last_status?.polaczenie ? <span className={String(p.last_status.polaczenie).startsWith("błąd") ? "text-bad" : ""}>{p.last_status.polaczenie}</span> : <span className="text-muted">–</span>}
                      {p.last_status?.tryb && <span className="block text-xs text-muted">tryb: {p.last_status.tryb}</span>}
                    </td>
                    <td>
                      <div className="flex flex-wrap items-start justify-end gap-1">
                        <form action={testPrinter}><input type="hidden" name="id" value={p.id} /><SubmitButton className="btn-secondary h-8 px-2.5 text-xs" pendingText="…">Sprawdź połączenie</SubmitButton></form>
                        <form action={togglePrinter}><input type="hidden" name="id" value={p.id} /><input type="hidden" name="active" value={p.active ? "0" : "1"} /><button className="btn-ghost h-8 px-2 text-xs">{p.active ? "Wyłącz" : "Włącz"}</button></form>
                        <RegenerateKeyForm id={p.id} />
                        <form action={deletePrinter}><input type="hidden" name="id" value={p.id} /><ConfirmSubmit className="btn-ghost h-8 px-2 text-xs text-bad" message={`Usunąć drukarkę ${p.name}? Program na komputerze przestanie działać.`}>Usuń</ConfirmSubmit></form>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card p-5">
        <h2 className="h2">Stawki PTU</h2>
        <p className="mb-4 mt-1 text-sm text-muted">Stawki A–F muszą odpowiadać stawkom zaprogramowanym w drukarce (raport „stawki PTU” z drukarki). Wpisz procent albo „zw”. Do wyboru w Kasie przy pozycjach spoza magazynu i we własnych produktach.</p>
        <form action={saveFiscalSettings} className="space-y-5">
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
            {PTU_LETTERS.map((l) => (
              <div key={l}>
                <label className="label" htmlFor={`rate_${l}`}>Stawka {l}</label>
                <div className="relative"><input id={`rate_${l}`} className="input pr-7 tabular-nums" name={`rate_${l}`} defaultValue={settings.rates[l]} maxLength={4} /><span className="pointer-events-none absolute right-2.5 top-2 text-sm text-muted">{settings.rates[l] === "zw" ? "" : "%"}</span></div>
              </div>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {([["ptu23", "Towar z magazynu – VAT 23%", settings.ptu23], ["ptuMargin", "Towar z magazynu – procedura marży", settings.ptuMargin], ["ptuService", "Usługi i wysyłka w zamówieniach", settings.ptuService]] as const).map(([name, label, value]) => (
              <div key={name}>
                <label className="label" htmlFor={name}>{label}</label>
                <select id={name} className="input" name={name} defaultValue={value}>
                  {PTU_LETTERS.map((l) => <option key={l} value={l}>{ptuLabel(settings, l)}</option>)}
                </select>
              </div>
            ))}
          </div>
          <SubmitButton className="btn-secondary" pendingText="Zapisuję…">Zapisz stawki</SubmitButton>
        </form>
      </section>

      <section className="card overflow-hidden">
        <div className="flex items-center justify-between p-5 pb-3"><h2 className="h2">Ostatnie paragony z kolejki</h2></div>
        <div className="overflow-x-auto">
          <table className="table">
            <thead><tr><th>#</th><th>Data</th><th>Sprzedaż</th><th className="text-right">Kwota</th><th>Stan</th><th>Drukarka</th></tr></thead>
            <tbody>
              {!jobs.length && <tr><td colSpan={6} className="py-8 text-center text-muted">Jeszcze nie było paragonów.</td></tr>}
              {jobs.map((j) => {
                const st = JOB_STATUS[j.status] ?? JOB_STATUS.queued;
                return (
                  <tr key={j.id}>
                    <td className="tabular-nums text-muted">{j.number}</td>
                    <td className="whitespace-nowrap text-sm text-muted">{dateTime(j.created_at)}</td>
                    <td className="text-sm">{j.source === "test" ? "test połączenia" : j.pos_order_id ? <a className="text-accent hover:underline" href={`/kasa/${j.pos_order_id}`}>Kasa</a> : j.order_id ? <a className="text-accent hover:underline" href={`/sprzedaz/${j.order_id}`}>zamówienie</a> : "–"}</td>
                    <td className="text-right tabular-nums">{j.source === "test" ? "–" : money(j.total)}</td>
                    <td className="text-sm">
                      <Pill tone={st.tone}>{st.text}</Pill>
                      {j.status === "printed" && j.source !== "test" ? (
                        <form action={fixReceiptNumber} className="mt-1 flex items-center gap-1" title="Numer jak na papierze (numer wydruku). Popraw, jeśli się różni.">
                          <input type="hidden" name="id" value={j.id} />
                          <input name="number" defaultValue={j.receipt_number ?? ""} className="input h-7 w-32 py-0 font-mono text-xs" aria-label="Numer paragonu" inputMode="numeric" />
                          <button className="text-xs text-accent hover:underline">popraw</button>
                        </form>
                      ) : j.receipt_number && <span className="ml-1 font-mono text-xs">{j.receipt_number}</span>}
                      {j.error && <span className="block max-w-md text-xs text-bad">{j.error}</span>}
                    </td>
                    <td className="text-sm text-muted">{j.printer?.name ?? "–"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
