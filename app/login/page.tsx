import { LoginForm } from "./LoginForm";
import { Icon } from "@/components/icons";

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const notice = sp.blad === "konto" ? "To konto nie ma dostępu do magazynu." : undefined;
  return (
    <main className="flex min-h-screen items-center justify-center bg-[radial-gradient(ellipse_at_top,rgb(37_99_235/0.08),transparent_60%)] px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-accent to-indigo-500 text-white shadow-md"><Icon name="box" className="h-5 w-5" /></span>
          <h1 className="h1">Zaloguj się</h1>
          <p className="mt-1 text-sm text-muted">Magazyn · Telefoniki · Sneakers Depot</p>
        </div>
        <div className="card p-6">
          <LoginForm next={sp.next ?? "/magazyn"} notice={notice} />
        </div>
      </div>
    </main>
  );
}
