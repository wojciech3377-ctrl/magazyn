import { requireProfile } from "@/lib/auth";
import { signOut } from "@/app/login/actions";
import { Nav } from "./Nav";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { profile } = await requireProfile();
  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-3 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center justify-between gap-6">
            <span className="font-semibold tracking-tight">Magazyn</span>
            <form action={signOut} className="md:hidden">
              <button className="text-sm text-muted hover:text-ink">Wyloguj</button>
            </form>
          </div>
          <Nav />
          <form action={signOut} className="hidden items-center gap-3 md:flex">
            <span className="text-sm text-muted">{profile.full_name || profile.email}</span>
            <button className="text-sm text-muted hover:text-ink">Wyloguj</button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </div>
  );
}
