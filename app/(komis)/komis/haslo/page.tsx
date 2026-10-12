import Link from "next/link";
import { requireConsignor } from "@/lib/consignment";
import { Icon } from "@/components/icons";
import { PasswordForm } from "./PasswordForm";

export const metadata = { title: "Ustaw hasło" };

/** Pierwsze logowanie komisanta (hasło startowe) – obowiązkowa zmiana hasła; później zwykła zmiana hasła. */
export default async function ConsignorPasswordPage() {
  const { consignor } = await requireConsignor({ passwordPage: true });
  const first = !!(consignor as { must_change_password?: boolean }).must_change_password;
  return (
    <div className="mx-auto mt-4 max-w-md">
      <div className="card p-6">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent"><Icon name="lock" className="h-6 w-6" /></span>
        <h1 className="h1 mt-4">{first ? "Ustaw swoje hasło" : "Zmień hasło"}</h1>
        <p className="mb-5 mt-1.5 text-sm leading-relaxed text-muted">
          {first
            ? "Logujesz się hasłem startowym od nas. Zanim zobaczysz swój panel, ustaw własne hasło – hasło startowe przestanie działać."
            : "Nowe hasło będzie potrzebne przy następnym logowaniu."}
        </p>
        <PasswordForm first={first} />
      </div>
      {!first && <p className="mt-4 text-center text-sm"><Link className="text-accent hover:underline" href="/komis">Wróć do panelu</Link></p>}
    </div>
  );
}
