import { requireProfile } from "@/lib/auth";
import { signOut } from "@/app/login/actions";
import { Nav } from "./Nav";
import { createAdminClient } from "@/lib/supabase/admin";

/** Zgłoszenia komisantów czekające na nas: nowe zgłoszenia rzeczy i zlecenia wysyłki do komisanta. */
async function consignorAlerts() {
  try {
    const db = createAdminClient();
    const [a, b] = await Promise.all([
      db.from("consignor_intakes").select("id", { count: "exact", head: true }).eq("status", "review"),
      db.from("consignor_shipments").select("id", { count: "exact", head: true }).eq("status", "requested"),
    ]);
    return (a.count ?? 0) + (b.count ?? 0);
  } catch {
    return 0;
  }
}

/** Przyjęcie dostawy: do akceptacji (zgłoszenia komisantów, podpisane umowy) i w drodze. */
async function deliveryAlerts() {
  try {
    const db = createAdminClient();
    const [a, b, c, d] = await Promise.all([
      db.from("consignor_intakes").select("id", { count: "exact", head: true }).eq("status", "review"),
      db.from("contracts").select("id", { count: "exact", head: true }).eq("status", "signed").not("template", "is", null),
      db.from("consignor_intakes").select("id", { count: "exact", head: true }).in("status", ["to_send", "sent"]),
      db.from("units").select("id", { count: "exact", head: true }).eq("status", "in_transit"),
    ]);
    return { accept: (a.count ?? 0) + (b.count ?? 0), transit: (c.count ?? 0) + (d.count ?? 0) };
  } catch {
    return { accept: 0, transit: 0 };
  }
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { profile } = await requireProfile();
  const [alerts, delivery] = await Promise.all([consignorAlerts(), deliveryAlerts()]);
  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-7xl min-w-0 flex-col gap-3 px-4 py-3 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center justify-between gap-6">
            <span className="font-semibold tracking-tight">Magazyn</span>
            <form action={signOut} className="md:hidden">
              <button className="text-sm text-muted hover:text-ink">Wyloguj</button>
            </form>
          </div>
          <Nav badges={{
            "/komisanci": [{ n: alerts, tone: "red", title: "Zgłoszenia komisantów do obsłużenia" }],
            "/dostawa": [{ n: delivery.accept, tone: "green", title: "Do akceptacji" }, { n: delivery.transit, tone: "orange", title: "W drodze" }],
          }} />
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
