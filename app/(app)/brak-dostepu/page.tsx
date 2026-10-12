import { requireProfile } from "@/lib/auth";
import { Icon } from "@/components/icons";

export const metadata = { title: "Brak dostępu" };

/** Pracownik bez żadnego działu – prośba o nadanie uprawnień. */
export default async function NoAccessPage() {
  const { profile } = await requireProfile();
  return (
    <div className="mx-auto mt-16 max-w-md text-center">
      <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-500"><Icon name="lock" className="h-7 w-7" /></span>
      <h1 className="h1 mt-4">Brak dostępu</h1>
      <p className="mt-2 text-sm text-muted">Twoje konto ({profile.email}) nie ma jeszcze dostępu do żadnego działu. Poproś administratora, żeby zaznaczył działy w panelu Pracownicy.</p>
    </div>
  );
}
