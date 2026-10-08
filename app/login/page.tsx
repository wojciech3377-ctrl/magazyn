import { LoginForm } from "./LoginForm";

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const notice = sp.blad === "konto" ? "To konto nie ma dostępu do magazynu." : undefined;
  return (
    <main className="flex min-h-screen items-center justify-center bg-panel px-4">
      <div className="card w-full max-w-sm p-6">
        <h1 className="h1 mb-1">Magazyn</h1>
        <p className="mb-6 text-sm text-muted">Telefoniki · Sneakers Depot</p>
        <LoginForm next={sp.next ?? "/magazyn"} notice={notice} />
      </div>
    </main>
  );
}
