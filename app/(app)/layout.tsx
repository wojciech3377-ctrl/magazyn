import { requireProfile } from "@/lib/auth";
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

/** Liczniki w menu liczą się przy każdym przejściu – pamiętamy je 20 s (szybsze przełączanie stron). */
let badgeCache: { at: number; value: [number, { accept: number; transit: number }] } | null = null;
async function badges() {
  if (badgeCache && Date.now() - badgeCache.at < 20_000) return badgeCache.value;
  const value = await Promise.all([consignorAlerts(), deliveryAlerts()]);
  badgeCache = { at: Date.now(), value };
  return value;
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { profile } = await requireProfile();
  const [alerts, delivery] = await badges();
  return (
    <div className="min-h-screen">
      <Nav
        user={profile.full_name || profile.email || ""}
        badges={{
          "/komisanci": [{ n: alerts, tone: "red", title: "Zgłoszenia komisantów do obsłużenia" }],
          "/dostawa": [{ n: delivery.accept, tone: "green", title: "Do akceptacji" }, { n: delivery.transit, tone: "orange", title: "W drodze" }],
        }}
      />
      <main className="min-w-0 px-4 py-5 sm:px-6 lg:ml-64 lg:px-8 lg:py-7 print:m-0 print:p-0">
        <div className="mx-auto max-w-[1500px]">{children}</div>
      </main>
    </div>
  );
}
