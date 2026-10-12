import { signOut } from "@/app/login/actions";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/** Panel komisanta – osobny układ (bez menu pracowników). */
/** Nazwa zalogowanego komisanta do nagłówka („Panel Jan Kowalski”). */
async function consignorName() {
  try {
    const { data: auth } = await (await createClient()).auth.getClaims();
    const uid = auth?.claims?.sub;
    if (!uid) return null;
    const { data } = await createAdminClient().from("consignors").select("name").eq("user_id", uid).maybeSingle();
    return (data?.name as string | undefined) ?? null;
  } catch {
    return null;
  }
}

export default async function KomisLayout({ children }: { children: React.ReactNode }) {
  const name = await consignorName();
  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <span className="font-semibold tracking-tight">{name ? `Panel ${name}` : "Panel komisanta"}</span>
          <form action={signOut}><button className="text-sm text-muted hover:text-ink">Wyloguj</button></form>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
