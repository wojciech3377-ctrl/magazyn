import Link from "next/link";
import { signOut } from "@/app/login/actions";
import { TableLabels } from "@/components/TableLabels";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { Icon } from "@/components/icons";
import type { Metadata } from "next";

/** Panel dodany do ekranu telefonu otwiera się od razu na panelu komisanta (osobna ikona „Mój komis”). */
export const metadata: Metadata = {
  manifest: "/komis.webmanifest",
  appleWebApp: { capable: true, title: "Mój komis", statusBarStyle: "default" },
};

/** Panel komisanta – osobny układ (bez menu pracowników). */
/** Nazwa zalogowanego komisanta do nagłówka („Panel Jan Kowalski”). */
async function consignorName() {
  try {
    const { data: auth } = await (await createClient()).auth.getClaims();
    const uid = auth?.claims?.sub;
    if (!uid) return { name: null, staff: false };
    const db = createAdminClient();
    const [{ data }, { data: staff }] = await Promise.all([
      db.from("consignors").select("name").eq("user_id", uid).maybeSingle(),
      db.from("profiles").select("active").eq("id", uid).maybeSingle(),
    ]);
    return { name: (data?.name as string | undefined) ?? null, staff: !!staff?.active };
  } catch {
    return { name: null, staff: false };
  }
}

export default async function KomisLayout({ children }: { children: React.ReactNode }) {
  const { name, staff } = await consignorName();
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-line bg-white/90 backdrop-blur print:hidden">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <span className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-indigo-500 text-white shadow-sm"><Icon name="users" className="h-4 w-4" /></span>
            <span className="truncate font-semibold tracking-tight">{name ? `Panel ${name}` : "Panel komisanta"}</span>
          </span>
          <div className="flex items-center gap-1">
            {/* Komisant, który jest też pracownikiem – powrót do aplikacji. */}
            {staff && <Link className="btn-ghost" href="/magazyn" title="Aplikacja pracownika"><Icon name="box" className="h-4 w-4" /><span className="hidden sm:inline">Aplikacja</span></Link>}
            <Link className="btn-ghost" href="/komis/haslo" title="Zmień hasło"><Icon name="key" className="h-4 w-4" /><span className="hidden sm:inline">Hasło</span></Link>
            <form action={signOut}><button className="btn-ghost"><Icon name="logout" className="h-4 w-4" /> Wyloguj</button></form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:py-8">{children}<TableLabels /></main>
    </div>
  );
}
