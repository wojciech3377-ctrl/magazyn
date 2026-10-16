import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { signOut } from "@/app/login/actions";
import { Icon } from "@/components/icons";
import { PasswordForm } from "./PasswordForm";

export const metadata = { title: "Hasło" };

/** Pracownik: obowiązkowa zmiana hasła tymczasowego (nowe konto / hasło od administratora) albo zwykła zmiana hasła. */
export default async function StaffPasswordPage() {
  const { profile } = await requireProfile();
  const first = !!profile.must_change_password;
  return (
    <div className="min-h-screen px-4 py-10">
      <div className="mx-auto max-w-md">
        <div className="card p-6">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent"><Icon name="lock" className="h-6 w-6" /></span>
          <h1 className="h1 mt-4">{first ? "Ustaw swoje hasło" : "Zmień hasło"}</h1>
          <p className="mb-5 mt-1.5 text-sm leading-relaxed text-muted">
            {first
              ? "Logujesz się hasłem tymczasowym. Zanim przejdziesz do aplikacji, ustaw własne hasło – tymczasowe przestanie działać."
              : "Nowe hasło będzie potrzebne przy następnym logowaniu."}
          </p>
          <PasswordForm first={first} />
        </div>
        <div className="mt-4 flex justify-center gap-4 text-sm">
          {!first && <Link className="text-accent hover:underline" href="/magazyn">Wróć do aplikacji</Link>}
          <form action={signOut}><button className="text-muted hover:underline">Wyloguj</button></form>
        </div>
      </div>
    </div>
  );
}
