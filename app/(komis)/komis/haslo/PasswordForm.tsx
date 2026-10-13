"use client";

import { useActionState, useState } from "react";
import { SubmitButton } from "@/components/SubmitButton";
import { setConsignorPassword, type PasswordState } from "./actions";

export function PasswordForm({ first }: { first: boolean }) {
  const [state, action] = useActionState<PasswordState, FormData>(setConsignorPassword, null);
  const [show, setShow] = useState(false);
  return (
    <form action={action} className="space-y-4">
      {!first && (
        <div>
          <label className="label" htmlFor="pw0">Obecne hasło</label>
          <input id="pw0" className="input" name="current" type={show ? "text" : "password"} autoComplete="current-password" required autoFocus />
        </div>
      )}
      <div>
        <label className="label" htmlFor="pw">Nowe hasło</label>
        <input id="pw" className="input" name="password" type={show ? "text" : "password"} autoComplete="new-password" minLength={10} required autoFocus={first} />
        <p className="mt-1 text-xs text-muted">Co najmniej 10 znaków, litery i cyfry.</p>
      </div>
      <div>
        <label className="label" htmlFor="pw2">Powtórz hasło</label>
        <input id="pw2" className="input" name="repeat" type={show ? "text" : "password"} autoComplete="new-password" minLength={10} required />
      </div>
      <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> pokaż hasło</label>
      {state?.error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-bad" role="alert">{state.error}</p>}
      <SubmitButton className="btn w-full" pendingText="Zapisuję…">{first ? "Ustaw hasło i przejdź do panelu" : "Zmień hasło"}</SubmitButton>
    </form>
  );
}
