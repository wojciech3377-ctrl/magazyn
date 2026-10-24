import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { PageHeader, Notice } from "@/components/ui";
import { contractHistory } from "@/lib/contracts/history";
import { dateTime } from "@/lib/labels";
import { SearchInput } from "@/components/SearchInput";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Historia umów" };

/** Historia wszystkich umów: utworzenie, zmiany, podpis, zatwierdzenie, opłacenie, usunięcie (z dostępem do pliku). */
export default async function ContractHistoryPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { supabase } = await requireProfile();
  const q = (sp.q ?? "").trim().slice(0, 60);
  const { error } = await supabase.from("contract_events").select("id", { head: true, count: "exact" }).limit(1);
  const items = error ? [] : await contractHistory(supabase, { limit: 300, search: q || undefined });
  // Pliki usuniętych umów – link ważny 10 minut.
  const files = new Map<string, string>();
  for (const it of items.filter((i) => i.filePath)) {
    const { data } = await createAdminClient().storage.from("contracts").createSignedUrl(it.filePath!, 600);
    if (data?.signedUrl) files.set(it.filePath!, data.signedUrl);
  }
  return (
    <>
      <PageHeader title="Historia umów" sub="Każda zmiana umowy – także usuniętych (plik zostaje)." actions={<Link className="btn-secondary" href="/umowy">Wróć do umów</Link>} />
      {error && <div className="mb-4"><Notice tone="error">Uruchom migrację <b>0073_contract_history_backups.sql</b> w Supabase – od tej chwili historia będzie zapisywana.</Notice></div>}
      <form className="mb-4 max-w-xl"><SearchInput name="q" defaultValue={q} placeholder="Numer umowy albo kontrahent" /></form>
      {!items.length ? <p className="card p-8 text-center text-sm text-muted">Brak wpisów{q ? ` dla „${q}”` : ""}.</p> : (
        <ul className="card divide-y divide-line">
          {items.map((it, k) => (
            <li key={k} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
              <span className="w-32 shrink-0 text-xs text-muted">{dateTime(it.at)}</span>
              {it.deleted
                ? <span className="font-medium text-bad">{it.label ?? "umowa"}</span>
                : <Link className="font-medium text-accent hover:underline" href={`/umowy/${it.contractId}`}>{it.label ?? "umowa"}</Link>}
              <span className="min-w-0 flex-1">{it.text}</span>
              {it.who && <span className="text-xs text-muted">{it.who}</span>}
              {it.filePath && files.get(it.filePath) && <a className="text-xs text-accent underline" href={files.get(it.filePath)} target="_blank" rel="noreferrer">plik</a>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
