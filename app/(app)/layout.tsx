import { requireProfile } from "@/lib/auth";
import { can, SECTIONS } from "@/lib/permissions";
import { Nav } from "./Nav";
import { TableLabels } from "@/components/TableLabels";
import { LivePoller } from "./LiveSync";
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
let badgeCache: { at: number; value: [number, { accept: number; transit: number }, number] } | null = null;
/** Nowe zamówienia (do spakowania / wysłania) – licznik przy „Sprzedaż” i zakładce „Zamówienia”. */
async function newOrdersCount() {
  try {
    const { count } = await createAdminClient().from("orders").select("id", { count: "exact", head: true }).eq("status", "new");
    return count ?? 0;
  } catch {
    return 0;
  }
}
async function badges() {
  if (badgeCache && Date.now() - badgeCache.at < 20_000) return badgeCache.value;
  const value = await Promise.all([consignorAlerts(), deliveryAlerts(), newOrdersCount()]);
  badgeCache = { at: Date.now(), value };
  return value;
}

/** Otwarte zadania osoby (przypisane do niej albo do wszystkich). */
async function myOpenTasks(db: Awaited<ReturnType<typeof requireProfile>>["supabase"], userId: string) {
  try {
    const { count } = await db.from("tasks").select("id", { count: "exact", head: true }).is("done_at", null).or(`assignees.eq.{},assignees.cs.{${userId}}`);
    return count ?? 0;
  } catch {
    return 0;
  }
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { supabase, profile } = await requireProfile();
  const [[alerts, delivery, newOrders], todo] = await Promise.all([badges(), myOpenTasks(supabase, profile.id)]);
  // Menu: działy z uprawnień (Faktury są zakładką w Sprzedaży), Ustawienia i Pracownicy – administrator.
  const allowed = [
    "/do-zrobienia",
    ...SECTIONS.filter((s) => s.key !== "faktury" && can(profile, s.key)).map((s) => s.href),
    ...(can(profile, "faktury") && !can(profile, "sprzedaz") ? ["/sprzedaz"] : []),
    ...(profile.role === "admin" ? ["/ustawienia", "/pracownicy"] : []),
  ];
  return (
    <div className="min-h-screen">
      <Nav
        user={profile.full_name || profile.email || ""}
        allowed={allowed}
        badges={{
          "/do-zrobienia": [{ n: todo, tone: "orange", title: "Twoje otwarte zadania" }],
          ...(can(profile, "sprzedaz") ? { "/sprzedaz": [{ n: newOrders, tone: "orange" as const, title: "Nowe zamówienia" }] } : {}),
          "/komisanci": [{ n: alerts, tone: "red", title: "Zgłoszenia komisantów do obsłużenia" }],
          "/dostawa": [{ n: delivery.accept, tone: "green", title: "Do akceptacji" }, { n: delivery.transit, tone: "orange", title: "W drodze" }],
        }}
      />
      <main className="app-main min-w-0 px-4 pb-[calc(5.5rem+env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))] sm:px-6 lg:ml-64 lg:px-8 lg:py-7 print:m-0 print:p-0">
        <div className="mx-auto max-w-[1500px]">{children}</div>
        <TableLabels />
        <LivePoller />
      </main>
    </div>
  );
}
