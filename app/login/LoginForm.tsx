"use client";

import { useActionState } from "react";
import { signIn } from "./actions";

export function LoginForm({ next, notice }: { next: string; notice?: string }) {
  const [state, action, pending] = useActionState(signIn, null);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="next" value={next} />
      <div>
        <label className="label" htmlFor="email">E-mail</label>
        <input className="input" id="email" name="email" type="email" autoComplete="email" required />
      </div>
      <div>
        <label className="label" htmlFor="password">Hasło</label>
        <input className="input" id="password" name="password" type="password" autoComplete="current-password" required />
      </div>
      {(state?.error || notice) && <p className="text-sm text-bad">{state?.error ?? notice}</p>}
      <button className="btn w-full" disabled={pending}>{pending ? "Logowanie…" : "Zaloguj"}</button>
    </form>
  );
}
