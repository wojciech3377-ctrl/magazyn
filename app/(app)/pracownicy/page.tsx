import { guardAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { SECTIONS } from "@/lib/permissions";
import { dateTime } from "@/lib/labels";
import { Notice, PageHeader, Pill } from "@/components/ui";
import { EmployeeEditor, NewEmployee, type Employee } from "./EmployeeForms";

export const metadata = { title: "Pracownicy" };

const AVATAR = ["bg-blue-100 text-blue-700", "bg-emerald-100 text-emerald-700", "bg-amber-100 text-amber-800", "bg-rose-100 text-rose-700", "bg-violet-100 text-violet-700", "bg-cyan-100 text-cyan-800"];

/** Pracownicy: konta, role, dostęp do działów, blokada i hasła. Tylko administrator. */
export default async function PracownicyPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { supabase, profile } = await guardAdmin();
  const { data: rows, error } = await supabase.from("profiles").select("*").order("created_at");
  // Ostatnie logowanie z Supabase Auth.
  const lastSeen = new Map<string, string | null>();
  try {
    const { data } = await createAdminClient().auth.admin.listUsers({ perPage: 500 });
    for (const u of data?.users ?? []) lastSeen.set(u.id, u.last_sign_in_at ?? null);
  } catch {
    // brak – pokażemy bez daty logowania
  }
  const list = ((rows ?? []) as Omit<Employee, "last_sign_in_at">[]).map((r) => ({ ...r, last_sign_in_at: lastSeen.get(r.id) ?? null }));
  const migrated = list.every((e) => Array.isArray(e.permissions));
  const sorted = [...list].sort((a, b) => Number(b.active) - Number(a.active) || Number(b.role === "admin") - Number(a.role === "admin") || (a.full_name ?? a.email ?? "").localeCompare(b.full_name ?? b.email ?? "", "pl"));
  const active = list.filter((e) => e.active).length;
  // Dziennik bezpieczeństwa (migracja 0042): ostatnie 7 dni.
  const { data: events, error: evErr } = await supabase.from("security_events").select("id, at, kind, subject, ip, detail")
    .gte("at", new Date(Date.now() - 7 * 86400_000).toISOString()).order("at", { ascending: false }).limit(40);

  return (
    <>
      <PageHeader
        title="Pracownicy"
        sub={<>{active} {active === 1 ? "aktywne konto" : "aktywnych kont"} · Administrator ma dostęp do wszystkiego, pracownik tylko do zaznaczonych działów.</>}
        actions={<NewEmployee />}
      />
      {sp.ok && <div className="mb-4"><Notice tone="ok">{sp.ok}</Notice></div>}
      {sp.blad && <div className="mb-4"><Notice tone="error">{sp.blad}</Notice></div>}
      {error && <div className="mb-4"><Notice tone="error">{error.message}</Notice></div>}
      {!migrated && <div className="mb-4"><Notice tone="error">Uruchom migrację <b>0038_permissions.sql</b> w Supabase (SQL Editor) – do tego czasu wszyscy pracownicy mają dostęp do wszystkich działów.</Notice></div>}

      <div className="grid items-start gap-3 xl:grid-cols-2">
        {sorted.map((e, i) => {
          const name = e.full_name || e.email || "bez nazwy";
          const initials = name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((x) => x[0]?.toUpperCase()).join("");
          const perms = e.role === "admin" ? null : SECTIONS.filter((s) => (e.permissions ?? SECTIONS.map((x) => x.key)).includes(s.key));
          return (
            <section key={e.id} className={`card p-4 ${e.active ? "" : "bg-slate-50/80"}`}>
              <div className="flex flex-wrap items-start gap-3">
                <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${e.active ? AVATAR[i % AVATAR.length] : "bg-slate-200 text-slate-500"}`}>{initials || "?"}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="truncate font-semibold">{name}</span>
                    {e.id === profile.id && <span className="text-xs text-muted">(to Ty)</span>}
                    {e.role === "admin" ? <Pill tone="blue">Administrator</Pill> : <Pill>Pracownik</Pill>}
                    {!e.active && <Pill tone="red">zablokowany</Pill>}
                  </div>
                  <div className="truncate text-sm text-muted">{e.email}{e.phone ? ` · ${e.phone}` : ""}</div>
                  <div className="mt-0.5 text-xs text-muted">{e.last_sign_in_at ? `ostatnie logowanie ${dateTime(e.last_sign_in_at)}` : "jeszcze się nie logował(a)"}</div>
                </div>
                <EmployeeEditor e={e} self={e.id === profile.id} open={sp.edytuj === e.id} />
                <div className="basis-full">
                  {perms === null ? (
                    <span className="text-xs text-muted">Pełny dostęp · Ustawienia · Pracownicy</span>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {perms.length === 0 && <span className="text-xs text-bad">brak dostępu do działów</span>}
                      {perms.map((s) => <span key={s.key} className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">{s.label}</span>)}
                      {e.can_see_prices && <span className="rounded-md bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">ceny zakupu</span>}
                    </div>
                  )}
                </div>
              </div>
            </section>
          );
        })}
      </div>
      <section className="card mt-6 p-4 sm:p-5">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-semibold">Bezpieczeństwo · ostatnie 7 dni</h2>
          <span className="text-xs text-muted">nieudane logowania, blokady po zbyt wielu próbach, złe klucze drukarki</span>
        </div>
        {evErr ? (
          <p className="text-sm text-muted">Uruchom migrację <b>0042_security.sql</b> w Supabase (SQL Editor), żeby włączyć limity prób i ten dziennik.</p>
        ) : !events?.length ? (
          <p className="text-sm text-muted">Brak zdarzeń. 👍</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {events.map((ev) => (
              <li key={ev.id as number} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-2">
                <span className="w-32 shrink-0 text-xs text-muted">{dateTime(ev.at as string)}</span>
                <Pill tone={/blocked/.test(ev.kind as string) ? "red" : "amber"}>{EVENT[ev.kind as string] ?? (ev.kind as string)}</Pill>
                <span className="min-w-0 truncate">{(ev.subject as string | null) ?? "–"}</span>
                <span className="ml-auto font-mono text-xs text-muted">{ev.ip as string}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

const EVENT: Record<string, string> = {
  login_failed: "nieudane logowanie",
  login_blocked: "logowanie zablokowane",
  password_change_wrong_current: "złe obecne hasło",
  public_form_blocked: "formularz publiczny zablokowany",
  printer_bad_key: "zły klucz drukarki",
};
