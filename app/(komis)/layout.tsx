import { signOut } from "@/app/login/actions";

/** Panel komisanta – osobny układ (bez menu pracowników). */
export default function KomisLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <span className="font-semibold tracking-tight">Panel komisanta</span>
          <form action={signOut}><button className="text-sm text-muted hover:text-ink">Wyloguj</button></form>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
