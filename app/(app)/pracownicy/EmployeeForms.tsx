"use client";

import { useActionState, useState } from "react";
import { SECTIONS } from "@/lib/permissions";
import { Icon } from "@/components/icons";
import { SubmitButton } from "@/components/SubmitButton";
import { ConfirmSubmit } from "@/components/ConfirmSubmit";
import { createEmployee, deleteEmployee, saveEmployee, setEmployeePassword, type CreateState } from "./actions";

export type Employee = {
  id: string; email: string | null; full_name: string | null; phone: string | null; role: "admin" | "staff";
  permissions: string[] | null; can_see_prices: boolean; active: boolean; last_sign_in_at: string | null; created_at: string;
};

/** Hasło startowe: 12 znaków bez mylących liter (0/O, 1/l). */
function newPassword() {
  const abc = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => abc[b % abc.length]).join("");
}

function RolePicker({ role, onChange }: { role: "admin" | "staff"; onChange: (r: "admin" | "staff") => void }) {
  return (
    <div>
      <div className="label">Rola</div>
      <input type="hidden" name="role" value={role} />
      <div className="grid grid-cols-2 gap-2">
        {([["staff", "Pracownik", "dostęp tylko do zaznaczonych działów"], ["admin", "Administrator", "wszystko, także Ustawienia i Pracownicy"]] as const).map(([k, label, desc]) => (
          <button type="button" key={k} onClick={() => onChange(k)} aria-pressed={role === k}
            className={`rounded-xl border p-3 text-left transition-colors ${role === k ? "border-accent bg-accent-soft ring-1 ring-accent" : "border-line bg-white hover:border-slate-300"}`}>
            <span className={`block text-sm font-semibold ${role === k ? "text-accent" : ""}`}>{label}</span>
            <span className="mt-0.5 block text-xs leading-snug text-muted">{desc}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Działy jako kafelki z przełącznikiem. Administrator – wszystkie (bez wyboru). */
function PermissionPicker({ role, initial, prices }: { role: "admin" | "staff"; initial: string[]; prices: boolean }) {
  const [on, setOn] = useState<Set<string>>(new Set(initial));
  const admin = role === "admin";
  const toggle = (k: string) => setOn((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="label mb-0">Dostęp do działów</span>
        {!admin && (
          <span className="flex gap-3 text-xs">
            <button type="button" className="text-accent hover:underline" onClick={() => setOn(new Set(SECTIONS.map((s) => s.key)))}>zaznacz wszystkie</button>
            <button type="button" className="text-muted hover:underline" onClick={() => setOn(new Set())}>odznacz</button>
          </span>
        )}
      </div>
      {admin && <p className="mb-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-muted">Administrator ma dostęp do wszystkich działów.</p>}
      <div className={`grid gap-2 sm:grid-cols-2 ${admin ? "pointer-events-none opacity-50" : ""}`}>
        {SECTIONS.map((s) => {
          const checked = admin || on.has(s.key);
          return (
            <label key={s.key} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors ${checked ? "border-accent/60 bg-accent-soft/60" : "border-line bg-white hover:border-slate-300"}`}>
              <input type="checkbox" name="perm" value={s.key} checked={checked} onChange={() => toggle(s.key)} className="peer sr-only" />
              <span aria-hidden="true" className={`mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-accent/40 ${checked ? "bg-accent" : "bg-slate-300"}`}>
                <span className={`h-4 w-4 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-4" : ""}`} />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">{s.label}</span>
                <span className="block text-xs leading-snug text-muted">{s.desc}</span>
              </span>
            </label>
          );
        })}
      </div>
      <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-white p-3">
        <input type="checkbox" name="can_see_prices" defaultChecked={prices} className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]" />
        <span>
          <span className="block text-sm font-medium">Widzi ceny zakupu</span>
          <span className="block text-xs text-muted">ceny zakupu, kwoty komisantów, PDF umów z cenami, eksport JPK do Excela</span>
        </span>
      </label>
    </div>
  );
}

function PasswordField({ name = "password", label }: { name?: string; label: string }) {
  const [value, setValue] = useState("");
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <label className="label" htmlFor={`pw-${name}-${label}`}>{label}</label>
      <div className="flex gap-2">
        <input id={`pw-${name}-${label}`} className="input font-mono" name={name} value={value} onChange={(e) => setValue(e.target.value)} minLength={10} autoComplete="new-password" placeholder="min. 10 znaków" required />
        <button type="button" className="btn-secondary shrink-0" onClick={() => { setValue(newPassword()); setCopied(false); }}>Wygeneruj</button>
        {value && (
          <button type="button" className="btn-ghost shrink-0 px-2" onClick={() => navigator.clipboard?.writeText(value).then(() => setCopied(true))} title="Kopiuj hasło">
            {copied ? <Icon name="check" className="h-4 w-4 text-ok" /> : "Kopiuj"}
          </button>
        )}
      </div>
    </div>
  );
}

export function NewEmployee() {
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<"admin" | "staff">("staff");
  const [state, action] = useActionState<CreateState, FormData>(createEmployee, null);
  return (
    <>
      <button type="button" className="btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Icon name="plus" className="h-4 w-4" /> Dodaj pracownika
      </button>
      {state?.ok && !open && <p className="basis-full text-sm text-ok">{state.ok}</p>}
      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 backdrop-blur-[2px] sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label="Nowy pracownik" onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <form action={action} className="max-h-[92dvh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 shadow-(--shadow-pop) sm:max-w-2xl sm:rounded-2xl">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold tracking-tight">Nowy pracownik</h2>
                <p className="text-sm text-muted">Pracownik loguje się e-mailem i hasłem startowym. Nic nie wysyłamy mailem.</p>
              </div>
              <button type="button" className="btn-ghost h-9 w-9 px-0" onClick={() => setOpen(false)} aria-label="Zamknij"><Icon name="close" className="h-5 w-5" /></button>
            </div>
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div><label className="label" htmlFor="ne-name">Imię i nazwisko</label><input id="ne-name" className="input" name="full_name" autoComplete="off" /></div>
                <div><label className="label" htmlFor="ne-phone">Telefon (opcjonalnie)</label><input id="ne-phone" className="input" name="phone" inputMode="tel" autoComplete="off" /></div>
                <div><label className="label" htmlFor="ne-email">E-mail (login)</label><input id="ne-email" className="input" type="email" name="email" required autoComplete="off" /><p className="mt-1 text-xs text-muted">E-mail komisanta z kontem → to samo konto dostanie też dostęp pracownika (zostaje jego hasło).</p></div>
                <PasswordField label="Hasło startowe" />
              </div>
              <RolePicker role={role} onChange={setRole} />
              <PermissionPicker role={role} initial={["magazyn", "dostawa", "kasa", "sprzedaz"]} prices={false} />
              {state?.error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-bad">{state.error}</p>}
              {state?.ok && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-ok">{state.ok}</p>}
              <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
                <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>{state?.ok ? "Zamknij" : "Anuluj"}</button>
                <SubmitButton pendingText="Tworzę konto…">Utwórz konto</SubmitButton>
              </div>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

export function EmployeeEditor({ e, self, open: initiallyOpen }: { e: Employee; self: boolean; open: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const [role, setRole] = useState<"admin" | "staff">(e.role);
  if (!open) {
    return <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => setOpen(true)}>Edytuj</button>;
  }
  return (
    <div className="basis-full space-y-4 border-t border-line pt-4">
      <form action={saveEmployee} className="space-y-4">
        <input type="hidden" name="id" value={e.id} />
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label className="label" htmlFor={`n-${e.id}`}>Imię i nazwisko</label><input id={`n-${e.id}`} className="input" name="full_name" defaultValue={e.full_name ?? ""} /></div>
          <div><label className="label" htmlFor={`p-${e.id}`}>Telefon</label><input id={`p-${e.id}`} className="input" name="phone" inputMode="tel" defaultValue={e.phone ?? ""} /></div>
        </div>
        {self ? <input type="hidden" name="role" value="admin" /> : <RolePicker role={role} onChange={setRole} />}
        <PermissionPicker role={role} initial={e.permissions ?? SECTIONS.map((s) => s.key)} prices={e.can_see_prices} />
        {self ? <input type="hidden" name="active" value="on" /> : (
          <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-line p-3">
            <input type="checkbox" name="active" defaultChecked={e.active} className="h-4 w-4 accent-[var(--color-accent)]" />
            <span><span className="block text-sm font-medium">Konto aktywne</span><span className="block text-xs text-muted">odznacz, żeby zablokować logowanie (np. koniec współpracy)</span></span>
          </label>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Anuluj</button>
          <SubmitButton pendingText="Zapisuję…">Zapisz zmiany</SubmitButton>
        </div>
      </form>
      <div className="grid gap-3 border-t border-line pt-4 sm:grid-cols-[1fr_auto] sm:items-end">
        <form action={setEmployeePassword} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="id" value={e.id} />
          <div className="min-w-0 flex-1"><PasswordField label="Nowe hasło" /></div>
          <SubmitButton className="btn-secondary" pendingText="Ustawiam…"><Icon name="key" className="h-4 w-4" /> Ustaw hasło</SubmitButton>
        </form>
        {!self && (
          <form action={deleteEmployee}>
            <input type="hidden" name="id" value={e.id} />
            <ConfirmSubmit className="btn-danger w-full" message={`Usunąć konto ${e.email}? Jeśli pracownik ma historię w aplikacji, konto zostanie tylko zablokowane.`}>Usuń konto</ConfirmSubmit>
          </form>
        )}
      </div>
    </div>
  );
}
