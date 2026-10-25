import { createAdminClient } from "@/lib/supabase/admin";
import { listBackups } from "@/lib/backup";
import { SubmitButton } from "@/components/SubmitButton";
import { dateTime } from "@/lib/labels";
import { makeBackupNow } from "./actions";

const mb = (n: number | null) => (n === null ? "" : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Ustawienia → Kopia zapasowa: codzienne kopie danych, kopia teraz, ZIP plików umów za miesiąc. */
export async function BackupSettings() {
  const db = createAdminClient();
  const [base, zips, { data: last }, { data: marker }] = await Promise.all([
    listBackups(db, "baza"), listBackups(db, "umowy"),
    db.from("sync_log").select("ok, message, created_at").eq("job", "backup").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("sync_state").select("value").eq("key", "contracts_new_download").maybeSingle(),
  ]);
  const newSince = (marker?.value as { at?: string } | null)?.at ?? null;
  const now = new Date();
  const months = Array.from({ length: 18 }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });
  return (
    <div className="space-y-5">
      <section className="card p-4">
        <h2 className="h2 mb-1">Kopia danych aplikacji</h2>
        <p className="mb-3 text-sm text-muted">
          Wszystkie dane (magazyn, umowy i ich historia, zamówienia, sprzedaż, faktury, paragony, komis, kasa) w jednym pliku <code>.json.gz</code>.
          Automatycznie codziennie w nocy (po SQL 73); kopie starsze niż 30 dni są usuwane (zostaje co najmniej 7). Bez haseł i kluczy.
          Pobierz kopię od czasu do czasu i trzymaj ją także poza Supabase (dysk, Google Drive).
        </p>
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <form action={makeBackupNow}><SubmitButton pendingText="Robię kopię… (do kilku minut)">Zrób kopię teraz</SubmitButton></form>
          {last && <span className={`text-xs ${last.ok ? "text-muted" : "text-bad"}`}>Ostatnia automatyczna: {dateTime(last.created_at as string)}{last.ok ? "" : ` – błąd: ${String(last.message).slice(0, 160)}`}</span>}
        </div>
        {base.length ? (
          <ul className="divide-y divide-line rounded-lg border border-line text-sm">
            {base.map((f) => (
              <li key={f.path} className="flex items-center gap-3 px-3 py-2">
                <span className="min-w-0 flex-1 font-mono text-xs">{f.name}</span>
                <span className="text-xs text-muted">{mb(f.size)}</span>
                <a className="btn-secondary h-8 px-2.5 text-xs" href={`/api/kopia?plik=${encodeURIComponent(f.path)}`}>Pobierz</a>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-muted">Jeszcze nie ma kopii – kliknij „Zrób kopię teraz”.</p>}
      </section>

      <section className="card p-4">
        <h2 className="h2 mb-1">Pliki umów</h2>
        <p className="mb-3 text-sm text-muted">
          Pliki umów (wgrane skany, faktury, podpisane PDF) trafiają do kopii co noc razem z danymi – tylko nowe, raz skopiowane zostają
          na stałe (także po usunięciu umowy). Do zapisania poza Supabase: „Pobierz nowe pliki umów” – ZIP tylko z plikami, których
          jeszcze nie pobierałeś (najwyżej 300 umów naraz; gdy jest więcej, kliknij ponownie).
        </p>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <a className="btn" href="/api/kopia?umowy=nowe">Pobierz nowe pliki umów</a>
          {newSince && <span className="text-xs text-muted">Ostatnie pobranie obejmowało pliki do {dateTime(newSince)}.</span>}
        </div>
        <p className="mb-2 text-xs text-muted">Albo cały wybrany miesiąc (np. do księgowej):</p>
        <form action="/api/kopia" method="get" className="flex flex-wrap items-center gap-2">
          <select name="umowy" className="input w-auto" defaultValue={months[0]} aria-label="Miesiąc">
            {months.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <button className="btn-secondary">Pobierz ZIP umów z miesiąca</button>
          <span className="text-xs text-muted">Przygotowanie dużego miesiąca może potrwać do kilku minut.</span>
        </form>
        {zips.length > 0 && (
          <ul className="mt-3 divide-y divide-line rounded-lg border border-line text-sm">
            {zips.map((f) => (
              <li key={f.path} className="flex items-center gap-3 px-3 py-2">
                <span className="min-w-0 flex-1 font-mono text-xs">{f.name}</span>
                <span className="text-xs text-muted">{mb(f.size)}{f.created_at ? ` · ${dateTime(f.created_at)}` : ""}</span>
                <a className="btn-secondary h-8 px-2.5 text-xs" href={`/api/kopia?plik=${encodeURIComponent(f.path)}`}>Pobierz</a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card p-4 text-sm text-muted">
        <h2 className="h2 mb-1 text-ink">Co jeszcze jest zabezpieczone</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>Kod aplikacji – w repozytorium GitHub (każda zmiana zapisana, można wrócić do dowolnej wersji).</li>
          <li>Baza w Supabase – własne kopie Supabase (Database → Backups); ich liczba zależy od planu Supabase.</li>
          <li>Klucze i hasła – tylko w Vercel / Supabase Vault, nie trafiają do kopii.</li>
        </ul>
      </section>
    </div>
  );
}
