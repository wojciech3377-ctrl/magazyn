export function PublicShell({ company, children }: { company: string; children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-panel">
      <header className="border-b border-line bg-white">
        <div className="mx-auto max-w-6xl px-4 py-3 text-sm font-semibold">{company}</div>
      </header>
      <div className="mx-auto max-w-6xl px-4 py-6">{children}</div>
    </main>
  );
}
