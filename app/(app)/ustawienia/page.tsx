import { productTagCode } from "@/lib/price-tag-code";
import Link from "next/link";
import { redirect } from "next/navigation";
import { diagnoseStock } from "@/lib/stock-diagnose";
import { requireProfile } from "@/lib/auth";
import { dateTime } from "@/lib/labels";
import { Notice, PageHeader, Pill } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { listWebhooks, shopifyCredentials, WEBHOOK_TOPICS } from "@/lib/integrations/shopify";
import { getBuyerSignature, getCompany } from "@/lib/contracts/settings";
import { getSmtpSettings, mailConfig } from "@/lib/mail";
import { ContractSettings } from "./ContractSettings";
import { FiscalSettings } from "./FiscalSettings";
import { addExclusion, deleteExclusion, setExclusionName, disconnectFurgonetka, purgeExcluded, purgeNonShopify, registerWebhooks, runStockNow, saveSmtp, saveInvoiceSettings, saveLocation, saveSender, saveShopifyLocation, saveStockMaster, saveStore, checkOmnibus, saveOrdersDefaultStore, fixProductStockNow, dismissIssue, saveMirror, runMirrorNow, retryMirror, saveMirrorExclude, saveMirrorDelete } from "./actions";
import { compareStock, getStockMaster, planPushToShopify, shopifyLocations, type ShopifyLocation } from "@/lib/sync/shopify-stock";
import { furgonetkaConfigured, furgonetkaConnection } from "@/lib/integrations/furgonetka";
import { openIssues } from "@/lib/issues";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSender } from "@/lib/orders/sender";
import { appUrl } from "@/lib/app-url";
import { ksefConfigured, ksefEnv } from "@/lib/ksef/client";
import { sendTestMailAction, testKsefAction } from "../sprzedaz/faktury/actions";
import { errorMessage } from "@/lib/errors";
import { defaultOrderStore } from "@/lib/orders/default-store";
import { getFiscalSettings } from "@/lib/fiscal/jobs";
import { ExclusionVatSelect } from "./ExclusionVatSelect";
import { BackupSettings } from "./BackupSettings";

// „Zrób kopię teraz” – do kilku minut.
export const maxDuration = 300;

async function safe<T>(fn: () => Promise<T>): Promise<{ data: T | null; error: string | null }> {
  try {
    return { data: await fn(), error: null };
  } catch (e) {
    return { data: null, error: errorMessage(e) };
  }
}

const SETTINGS_TABS = [
  { key: "polaczenia", label: "Połączenia" },
  { key: "firma", label: "Firma i umowy" },
  { key: "faktury", label: "Faktury i KSeF" },
  { key: "drukarka", label: "Drukarka fiskalna" },
  { key: "wysylka", label: "Wysyłka" },
  { key: "sklepy", label: "Sklepy i lokalizacje" },
  { key: "stany", label: "Stany magazynowe" },
  { key: "wykluczenia", label: "Wykluczenia" },
  { key: "dziennik", label: "Dziennik" },
  { key: "kopia", label: "Kopia zapasowa" },
] as const;

export default async function UstawieniaPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  if (sp.zakladka === "uzytkownicy") redirect("/pracownicy");
  const tab = SETTINGS_TABS.find((t) => t.key === sp.zakladka)?.key ?? "polaczenia";
  const { supabase, profile } = await requireProfile();
  const isAdmin = profile.role === "admin";

  const [{ data: stores }, { data: locations }, , { data: logs }, { data: imported }, { data: exclusions }] = await Promise.all([
    supabase.from("stores").select("*").order("name"),
    supabase.from("locations").select("*").order("name"),
    Promise.resolve({ data: null }),
    supabase.from("sync_log").select("*").order("created_at", { ascending: false }).limit(15),
    supabase.from("sync_state").select("value").eq("key", "initial_stock_imported").maybeSingle(),
    supabase.from("catalog_exclusions").select("*").order("created_at"),
  ]);
  const fiscalCfg = await getFiscalSettings(createAdminClient());
  const [company, buyerSignature, { data: generalLink }] = isAdmin
    ? await Promise.all([getCompany(supabase), getBuyerSignature(supabase), supabase.from("app_settings").select("value").eq("key", "general_contract_link").maybeSingle()])
    : [null, null, { data: null }];
  const [sender, furgonetka, baseUrl] = isAdmin
    ? await Promise.all([getSender(supabase), furgonetkaConfigured() ? furgonetkaConnection(createAdminClient()) : Promise.resolve(null), appUrl()])
    : [null, null, ""];
  const storeName = new Map((stores ?? []).map((s) => [s.id, s.name]));
  // Stany: główne źródło, lokalizacje Shopify i (na żądanie) podgląd różnic.
  const stock = isAdmin && tab === "stany"
    ? await (async () => {
        const db = createAdminClient();
        const master = await getStockMaster(db);
        const shopLocs = new Map<string, { data: ShopifyLocation[] | null; error: string | null }>();
        for (const st of (stores ?? []).filter((x) => x.shopify_domain)) shopLocs.set(st.id, await safe(() => shopifyLocations(st.shopify_domain as string, st.code as string)));
        const plan = sp.podglad === "1" ? await safe(() => planPushToShopify(db)) : null;
        const compare = sp.porownaj === "1" ? await safe(() => compareStock(db)) : null;
        const { data: last } = await db.from("sync_log").select("job, ok, message, created_at").in("job", ["stock", "auto-catalog"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
        const { data: purge } = await db.rpc("purge_non_shopify", { p_dry_run: true });
        const diag = sp.sprawdz && sp.sprawdz.trim().length >= 2 ? await safe(() => diagnoseStock(db, sp.sprawdz!.trim())) : null;
        return { master, shopLocs, plan, compare, last, diag, purge: purge as { units: number; kept: number; variants: number } | null };
      })()
    : null;
  // Stan webhooków („na żywo”) każdego sklepu.
  const live = new Map<string, { topics: string[]; error: string | null }>();
  if (isAdmin && tab === "sklepy") {
    for (const st of (stores ?? []).filter((x) => x.shopify_domain)) {
      const r = await safe(() => listWebhooks(st.shopify_domain as string, st.code as string, `/api/shopify/webhook/${st.code}`));
      live.set(st.id, { topics: [...new Set((r.data ?? []).map((w) => w.topic))], error: r.error });
    }
  }
  // Sklepy-kopie (SQL 78): lokalizacje Shopify kopii, postęp kopiowania produktów, błędy.
  const mirrors = isAdmin && tab === "sklepy"
    ? await (async () => {
        const db = createAdminClient();
        const list = ((stores ?? []) as { id: string; name: string; code: string; shopify_domain: string | null; mirror_of?: string | null; mirror_location_id?: string | null }[]).filter((x) => x.mirror_of !== undefined);
        if (!list.length) return null; // brak SQL 78
        const { data: ms } = await db.from("app_settings").select("value").eq("key", "mirror").maybeSingle();
        const replace = ((ms?.value as { replace?: [string, string][] } | null)?.replace ?? []).map(([a, b]) => `${a} → ${b}`).join("\n");
        // Wykluczone produkty – kody metek (PR000123) i nazwy.
        const excludeIds = ((ms?.value as { exclude?: string[] } | null)?.exclude ?? []);
        const excluded: { id: string; title: string; code: string }[] = [];
        for (let i = 0; i < excludeIds.length; i += 300) {
          const { data } = await db.from("products").select("id, title, tag_no").in("id", excludeIds.slice(i, i + 300));
          for (const p of data ?? []) excluded.push({ id: p.id as string, title: p.title as string, code: p.tag_no ? productTagCode(p.tag_no as number) : "" });
        }
        excluded.sort((a, b) => a.code.localeCompare(b.code));
        const deleteOrphans = (ms?.value as { deleteOrphans?: boolean } | null)?.deleteOrphans === true;
        const mirrorLib = await import("@/lib/sync/mirror");
        const pairs = await mirrorLib.mirrorPairs(db, true);
        const rows = await Promise.all(list.filter((x) => x.mirror_of).map(async (m) => {
          const [locsR, { count: done }, { count: total }, { count: queued }, { data: failed }] = await Promise.all([
            m.shopify_domain ? safe(() => shopifyLocations(m.shopify_domain as string, m.code)) : Promise.resolve({ data: null, error: null }),
            db.from("product_store_links").select("id", { count: "exact", head: true }).eq("store_id", m.id),
            db.from("product_store_links").select("id", { count: "exact", head: true }).eq("store_id", m.mirror_of!),
            db.from("mirror_queue").select("product_id", { count: "exact", head: true }).eq("store_id", m.id).lt("attempts", 8),
            db.from("mirror_queue").select("last_error, attempts, product:products(title)").eq("store_id", m.id).gte("attempts", 1).order("attempts", { ascending: false }).limit(5),
          ]);
          // Podgląd: produkty w Shopify kopii bez powiązania z magazynem (do usunięcia, gdy usuwanie jest włączone).
          const pair = pairs.find((x) => x.mirror.id === m.id);
          const orphans = pair && m.mirror_location_id && !locsR.error ? await safe(() => mirrorLib.mirrorOrphans(db, pair, undefined, Date.now() + 15_000)) : null;
          return { store: m, shopLocs: locsR, orphans, done: done ?? 0, total: total ?? 0, queued: queued ?? 0, failed: (failed ?? []) as unknown as { last_error: string | null; attempts: number; product: { title: string } | null }[] };
        }));
        return { rows, replace, excluded, deleteOrphans, candidates: list, master: await getStockMaster(db) };
      })()
    : null;
  const ordersDefault = isAdmin && tab === "sklepy" ? await defaultOrderStore(supabase, (stores ?? []) as { id: string; name: string }[]) : "";
  const { data: invoiceSettings } = isAdmin && tab === "faktury" ? await supabase.from("app_settings").select("value").eq("key", "invoices").maybeSingle() : { data: null };

  const mail = isAdmin ? await mailConfig() : null;
  const smtp = isAdmin && tab === "faktury" ? await getSmtpSettings() : {};
  const smtpHasPassword = isAdmin && tab === "faktury" ? !!(await createAdminClient().rpc("smtp_password_exists")).data : false;
  const envStatus = [
    ["Supabase (klucz serwera)", !!process.env.SUPABASE_SERVICE_ROLE_KEY],
    ...(stores ?? []).map((s) => {
      const c = shopifyCredentials(s.code);
      return [`Shopify ${s.name}`, !!(c.clientId && c.clientSecret)] as [string, boolean];
    }),
    ["Zadanie cykliczne (CRON_SECRET)", !!process.env.CRON_SECRET],
    ["E-mail (SMTP)", !!mail],
    ["Furgonetka (klucze aplikacji)", furgonetkaConfigured()],
    [`KSeF (${ksefEnv()})`, ksefConfigured()],
  ] as [string, boolean][];
  const missing = envStatus.filter(([, ok]) => !ok).length;
  const issues = isAdmin ? await openIssues(createAdminClient()) : [];
  const fmt = (d: string) => new Date(d).toLocaleString("pl-PL", { timeZone: "Europe/Warsaw", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

  return (
    <>
      <PageHeader title="Ustawienia" />
      {sp.ok && <div className="mb-4"><Notice tone="ok">{sp.ok}</Notice></div>}
      {sp.blad && <div className="mb-4"><Notice tone="error">{sp.blad}</Notice></div>}
      {!isAdmin && <Notice>Ustawienia zmienia administrator.</Notice>}

      {issues.length > 0 && (
        <section id="bledy" className="card mb-5 border-rose-300 p-4">
          <h2 className="h2 mb-1 flex items-center gap-2">
            <span className="rounded-full bg-bad px-2 text-sm text-white tabular-nums">{issues.length}</span>
            Błędy automatu
          </h2>
          <p className="mb-3 text-sm text-muted">Automat (katalog, stany, zamówienia) czegoś nie zrobił. Błąd znika sam, gdy kolejny przebieg już go nie widzi.</p>
          <ul className="divide-y divide-line">
            {issues.map((i) => (
              <li key={i.key} className="py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="font-medium text-bad">{i.title}</p>
                  <form action={dismissIssue}>
                    <input type="hidden" name="key" value={i.key} />
                    <input type="hidden" name="back" value={`/ustawienia?zakladka=${tab}`} />
                    <button className="text-xs text-muted hover:text-ink hover:underline" title="Ukryj, dopóki się nie rozwiąże i nie wróci">ukryj</button>
                  </form>
                </div>
                {i.hint && <p className="mt-1 text-sm"><b>Co to znaczy i co zrobić:</b> {i.hint}</p>}
                {i.detail && <p className="mt-1 break-words font-mono text-xs text-muted">{i.detail}</p>}
                <p className="mt-1 text-xs text-muted">
                  od {fmt(i.first_seen_at)} · ostatnio {fmt(i.last_seen_at)}{i.count > 1 ? ` · ${i.count}× z rzędu` : ""}
                  {i.href && <> · <Link className="text-accent hover:underline" href={i.href}>przejdź</Link></>}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {isAdmin && (
        <div className="flex flex-col gap-5 md:flex-row md:items-start">
        <nav className="-mx-4 flex gap-1 overflow-x-auto px-4 md:sticky md:top-4 md:mx-0 md:w-52 md:shrink-0 md:flex-col md:px-0" aria-label="Sekcje ustawień">
          {SETTINGS_TABS.map((t) => (
            <Link key={t.key} href={`/ustawienia?zakladka=${t.key}`} aria-current={tab === t.key ? "page" : undefined}
              className={`whitespace-nowrap rounded-md px-3 py-2 text-sm ${tab === t.key ? "bg-ink font-medium text-white" : "text-muted hover:bg-panel hover:text-ink"}`}>
              {t.label}
              {t.key === "polaczenia" && missing > 0 && <span className="ml-1.5 rounded-full bg-bad px-1.5 text-xs text-white">{missing}</span>}
            </Link>
          ))}
        </nav>
        <div className="min-w-0 flex-1 space-y-5">
          {tab === "polaczenia" && (
          <section className="card p-4">
            <h2 className="h2 mb-3">Połączenia</h2>
            <div className="flex flex-wrap gap-2">
              {envStatus.map(([label, ok]) => <Pill key={label} tone={ok ? "green" : "red"}>{label}: {ok ? "ustawione" : "brak"}</Pill>)}
            </div>
            <p className="mt-2 text-xs text-muted">Klucze wpisuje się w Vercel → Settings → Environment Variables (nigdy w czacie ani w kodzie).</p>
          </section>
          )}

          {tab === "sklepy" && (
          <section className="card mb-5 p-4">
            <h2 className="h2">Zamówienia</h2>
            <form action={saveOrdersDefaultStore} className="mt-3 flex flex-wrap items-end gap-2">
              <div>
                <label className="label" htmlFor="default_store">Sklep pokazywany domyślnie w Sprzedaż → Zamówienia</label>
                <select id="default_store" className="input sm:w-72" name="default_store" defaultValue={ordersDefault}>
                  {stores?.map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}
                  <option value="wszystkie">Wszystkie sklepy</option>
                </select>
              </div>
              <SubmitButton className="btn-secondary">Zapisz</SubmitButton>
            </form>
            <p className="mt-2 text-xs text-muted">W Zamówieniach i tak można przełączyć sklep jednym kliknięciem.</p>
          </section>
          )}

          {tab === "sklepy" && (
          <section className="card p-4">
            <h2 className="h2 mb-3">Sklepy</h2>
            <div className="grid gap-4 md:grid-cols-2">
              {stores?.map((s) => (
                <form key={s.id} action={saveStore} className="space-y-2 rounded-md border border-line p-3">
                  <input type="hidden" name="id" value={s.id} />
                  <div className="font-medium">{s.name} <span className="text-xs text-muted">({s.code})</span></div>
                  <div><label className="label">Domena Shopify</label><input className="input" name="shopify_domain" defaultValue={s.shopify_domain ?? ""} placeholder="nazwa.myshopify.com" /></div>
                  <div className="flex flex-wrap gap-2">
                    <SubmitButton>Zapisz</SubmitButton>
                  </div>
                </form>
              ))}
            </div>
          </section>
          )}

          {tab === "sklepy" && mirrors && (
          <section className="card space-y-4 p-4">
            <div>
              <h2 className="h2 mb-1">Sklep-kopia</h2>
              <p className="text-sm text-muted">Te same produkty co w sklepie źródłowym: aplikacja tworzy je i aktualizuje w kopii (tytuł, opis, zdjęcia, rozmiary, ceny, tagi, status), a stany liczy z tych samych sztuk. Zamówienie z kopii zdejmuje sztukę z magazynu i od razu zmniejsza stan w obu sklepach.</p>
            </div>
            {mirrors.rows.length > 0 && mirrors.master !== "app" && <Notice tone="error">Główny stan to teraz Shopify. Przy sklepie-kopii ustaw w zakładce Stany magazynowe „Magazyn aplikacji” – inaczej zmiany stanu zrobione ręcznie w Shopify sklepu źródłowego dojdą do kopii z opóźnieniem (ryzyko sprzedaży tej samej sztuki dwa razy).</Notice>}
            {mirrors.rows.length === 0 && <p className="text-sm text-muted">Żaden sklep nie jest kopią. Wybierz niżej sklep źródłowy przy sklepie, który ma być kopią.</p>}
            {mirrors.rows.map(({ store: m, shopLocs, orphans, done: linked, total, queued, failed }) => (
              <div key={m.id} className="space-y-3 rounded-md border border-line p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{m.name}</span>
                  <span className="text-sm text-muted">kopia: {storeName.get(m.mirror_of!) ?? "?"}</span>
                  {!m.shopify_domain ? <Pill tone="amber">ustaw domenę Shopify wyżej</Pill> : shopLocs.error ? <Pill tone="red">brak połączenia z Shopify</Pill> : !m.mirror_location_id ? <Pill tone="amber">wybierz lokalizację Shopify</Pill> : <Pill tone="green">działa</Pill>}
                </div>
                <p className="text-sm">Produkty w kopii: <b className="tabular-nums">{linked}</b> z <b className="tabular-nums">{Math.max(0, total - mirrors.excluded.length)}</b>{queued ? <> · w kolejce: <b className="tabular-nums">{queued}</b></> : null}{mirrors.excluded.length ? <> · wykluczone: <b className="tabular-nums">{mirrors.excluded.length}</b></> : null}</p>
                {shopLocs.error && <p className="text-sm text-bad">Shopify {m.name}: {shopLocs.error}</p>}
                <form action={saveMirror} className="grid items-end gap-2 md:grid-cols-[1fr_1fr_auto]">
                  <input type="hidden" name="id" value={m.id} />
                  <div><label className="label" htmlFor={`src-${m.id}`}>Sklep źródłowy</label>
                    <select className="input" id={`src-${m.id}`} name="mirror_of" defaultValue={m.mirror_of ?? ""}>
                      <option value="">— nie jest kopią —</option>
                      {mirrors.candidates.filter((x) => x.id !== m.id && !x.mirror_of).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </select></div>
                  <div><label className="label" htmlFor={`loc-${m.id}`}>Lokalizacja Shopify kopii (tu trafia stan)</label>
                    <select className="input" id={`loc-${m.id}`} name="mirror_location_id" defaultValue={m.mirror_location_id ?? ""}>
                      <option value="">— wybierz —</option>
                      {(shopLocs.data ?? []).filter((l) => l.isActive).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                      {m.mirror_location_id && !(shopLocs.data ?? []).some((l) => l.id === m.mirror_location_id) && <option value={m.mirror_location_id}>zapisana: {m.mirror_location_id.split("/").pop()}</option>}
                    </select></div>
                  <SubmitButton className="btn-secondary">Zapisz</SubmitButton>
                </form>
                <div className="flex flex-wrap gap-2">
                  <form action={runMirrorNow}><SubmitButton pendingText="Kopiuję… (do 3 min)" disabled={!m.shopify_domain || !m.mirror_location_id}>Kopiuj produkty teraz</SubmitButton></form>
                  {failed.length > 0 && <form action={retryMirror}><input type="hidden" name="id" value={m.id} /><SubmitButton className="btn-secondary">Ponów produkty z błędem</SubmitButton></form>}
                </div>
                {failed.length > 0 && (
                  <ul className="space-y-1 text-xs text-bad">
                    {failed.map((f, i) => <li key={i}><b>{f.product?.title ?? "produkt"}</b> ({f.attempts}×): {f.last_error}</li>)}
                  </ul>
                )}
                <p className="text-xs text-muted">Kopiowanie idzie samo co 30 minut (nowe i zmienione produkty partiami; pojedyncze zmiany z webhooków źródła – od razu). „Kopiuj produkty teraz” tylko przyspiesza.</p>
                <form action={saveMirrorDelete} className="space-y-2 rounded-md border border-line p-3 text-sm">
                  <label className="flex items-start gap-2">
                    <input type="checkbox" name="delete_orphans" defaultChecked={mirrors.deleteOrphans} className="mt-1 h-4 w-4" />
                    <span><b>Usuwaj z {m.name} produkty, których nie ma w magazynie</b> <span className="block text-xs text-muted">Produkty w Shopify {m.name} bez powiązania z magazynem (dodane ręcznie, wykluczone wyżej, usunięte w {storeName.get(m.mirror_of!) ?? "źródle"}) – usuwane co 30 minut, najwyżej 50 naraz. Usunięcia nie da się cofnąć. Pomijane: produkty utworzone w ostatnich 2 godzinach i te, które aplikacja zaraz przejmie (ten sam adres co produkt w {storeName.get(m.mirror_of!) ?? "źródle"}).</span></span>
                  </label>
                  {orphans?.error && <p className="text-xs text-bad">Nie udało się sprawdzić produktów kopii: {orphans.error}</p>}
                  {orphans?.data && (orphans.data.orphans.length
                    ? <div className="text-xs"><p className="font-medium text-warn">{mirrors.deleteOrphans ? "Do usunięcia" : "Zostałyby usunięte"}: {orphans.data.orphans.length} z {orphans.data.total} produktów w Shopify {m.name}</p>
                        <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto text-muted">{orphans.data.orphans.slice(0, 100).map((o) => <li key={o.id}>{o.title} <span className="font-mono">/{o.handle}</span></li>)}</ul></div>
                    : <p className="text-xs text-ok">Brak produktów bez powiązania z magazynem ({orphans.data.total} w Shopify {m.name}).</p>)}
                  <SubmitButton className="btn-secondary">Zapisz</SubmitButton>
                </form>
                <p className="text-xs text-muted">Aplikacja w Shopify kopii (Dev Dashboard) potrzebuje uprawnień: <code className="rounded bg-panel px-1">read_products,write_products,read_publications,write_publications,read_inventory,write_inventory,read_locations,read_orders,write_orders,write_merchant_managed_fulfillment_orders</code>. Client ID i Secret wpisz w Vercel jako <code className="rounded bg-panel px-1">SHOPIFY_{m.code.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_CLIENT_ID</code> i <code className="rounded bg-panel px-1">…_CLIENT_SECRET</code>.</p>
              </div>
            ))}
            {mirrors.rows.length === 0 && (
              <div className="grid gap-2 md:grid-cols-2">
                {mirrors.candidates.filter((x) => !x.mirror_of).map((m) => (
                  <form key={m.id} action={saveMirror} className="flex flex-wrap items-end gap-2 rounded-md border border-line p-3">
                    <input type="hidden" name="id" value={m.id} />
                    <div className="min-w-48 flex-1"><label className="label">{m.name} – kopia sklepu</label>
                      <select className="input" name="mirror_of" defaultValue="">
                        <option value="">— nie jest kopią —</option>
                        {mirrors.candidates.filter((x) => x.id !== m.id && !x.mirror_of).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                      </select></div>
                    <SubmitButton className="btn-secondary">Zapisz</SubmitButton>
                  </form>
                ))}
              </div>
            )}
            {mirrors.rows.length > 0 && (
              <form action={saveMirror} className="space-y-2">
                <input type="hidden" name="id" value={mirrors.rows[0].store.id} />
                <input type="hidden" name="mirror_of" value={mirrors.rows[0].store.mirror_of ?? ""} />
                <label className="label" htmlFor="mirror-replace">Zamiana tekstu w opisach kopii (jedna zasada na linię: „z → na”, np. „Depot Check → Owca Check”)</label>
                <textarea className="input min-h-20 py-2 font-mono text-sm" id="mirror-replace" name="replace" defaultValue={mirrors.replace} placeholder={"Sneakers Depot → Owca Store"} />
                <SubmitButton className="btn-secondary">Zapisz zamiany</SubmitButton>
              </form>
            )}
            {mirrors.rows.length > 0 && (
              <form action={saveMirrorExclude} className="space-y-2">
                <label className="label" htmlFor="mirror-exclude">Wykluczone produkty – nie pokazują się w kopii (kody z metki produktu, np. PR000123; jeden na linię albo po przecinku)</label>
                <textarea className="input min-h-20 py-2 font-mono text-sm" id="mirror-exclude" name="exclude" defaultValue={mirrors.excluded.map((e) => e.code).filter(Boolean).join("\n")} placeholder={"PR000123\nPR000456"} />
                {mirrors.excluded.length > 0 && (
                  <ul className="max-h-48 space-y-0.5 overflow-y-auto text-xs text-muted">
                    {mirrors.excluded.map((e) => <li key={e.id}><span className="font-mono">{e.code}</span> – {e.title}</li>)}
                  </ul>
                )}
                <p className="text-xs text-muted">Wykluczony produkt, który jest już w kopii, trafia tam do archiwum (znika ze sklepu), a przy włączonym usuwaniu – jest usuwany. Usunięcie kodu z listy – produkt wraca do kopii przy kolejnym przebiegu. Pozostałe produkty kopiują się normalnie.</p>
                <SubmitButton className="btn-secondary">Zapisz wykluczenia</SubmitButton>
              </form>
            )}
          </section>
          )}

          {tab === "sklepy" && (
          <section className="card flex flex-wrap items-center gap-3 p-4">
            <div className="min-w-64 flex-1">
              <h2 className="h2 mb-1">Najniższa cena z 30 dni (metki)</h2>
              <p className="text-sm text-muted">Sprawdza, czy aplikacja widzi metapole „Lowest price” z Omnibus Insight. Niezależnie od tego aplikacja od 11.10 zapamiętuje każdą zmianę ceny.</p>
            </div>
            <form action={checkOmnibus}><SubmitButton className="btn-secondary" pendingText="Sprawdzam…">Sprawdź Omnibus</SubmitButton></form>
          </section>
          )}

          {tab === "sklepy" && (
          <section className="card p-4">
            <h2 className="h2 mb-1">Na żywo ze Shopify</h2>
            <p className="mb-3 text-sm text-muted">Nowe produkty, zamówienia, anulowania, zwroty i zmiany stanów trafiają do aplikacji od razu (webhooki). Wyłączone – co 15 minut.</p>
            <div className="space-y-2">
              {stores?.filter((st) => st.shopify_domain).map((st) => {
                const l = live.get(st.id);
                const on = (l?.topics.length ?? 0) > 0;
                const missing = WEBHOOK_TOPICS.filter((t) => !l?.topics.includes(t));
                return (
                  <form key={st.id} action={registerWebhooks} className="flex flex-wrap items-center gap-3">
                    <input type="hidden" name="id" value={st.id} />
                    <button type="submit" name="live" value={on ? "0" : "1"} role="switch" aria-checked={on} aria-label={`Na żywo: ${st.name}`}
                      className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${on ? "bg-ok" : "bg-line"}`}>
                      <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all ${on ? "left-[1.375rem]" : "left-0.5"}`} />
                    </button>
                    <span className="font-medium">{st.name}</span>
                    <span className="text-sm text-muted">
                      {l?.error ? <span className="text-bad">{l.error}</span>
                        : on ? (missing.length ? `włączone częściowo – brak: ${missing.map((m) => m.toLowerCase()).join(", ")} (stany wymagają uprawnień read_inventory)` : "włączone: produkty, zamówienia, zwroty, stany")
                        : "wyłączone"}
                    </span>
                    {on && missing.length > 0 && !l?.error && <button type="submit" name="live" value="1" className="btn-secondary px-2.5 py-1 text-xs">Włącz brakujące</button>}
                  </form>
                );
              })}
            </div>
          </section>
          )}

          {tab === "sklepy" && (
          <section className="card p-4">
            <h2 className="h2 mb-1">Lokalizacje</h2>
            <p className="mb-3 text-sm text-muted">Każda lokalizacja należy do sklepu; lokalizację Shopify przypisujesz w zakładce Stany magazynowe.</p>
            <div className="space-y-2">
              {locations?.map((l) => (
                <form key={l.id} action={saveLocation} className="grid items-end gap-2 md:grid-cols-[1fr_1fr_auto_auto]">
                  <input type="hidden" name="id" value={l.id} />
                  <select className="input" name="store_id" defaultValue={l.store_id} aria-label="Sklep">
                    {stores?.filter((s) => !s.mirror_of || s.id === l.store_id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  <input className="input" name="name" defaultValue={l.name} aria-label="Nazwa" />
                  <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" name="active" defaultChecked={l.active} /> aktywna</label>
                  <SubmitButton className="btn-secondary">Zapisz</SubmitButton>
                  <textarea className="input md:col-span-4" name="ship_address" rows={2} defaultValue={l.ship_address ?? ""} placeholder="Adres do wysyłki dla komisantów (odbiorca, ulica, kod, miasto, telefon) – widoczny w panelu komisanta" aria-label="Adres do wysyłki" />
                </form>
              ))}
              <form action={saveLocation} className="grid items-end gap-2 border-t border-line pt-3 md:grid-cols-[1fr_1fr_auto]">
                <select className="input" name="store_id" aria-label="Sklep">
                  {stores?.filter((s) => !s.mirror_of).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <input className="input" name="name" placeholder="Nowa lokalizacja, np. Poznań – Długa 13" aria-label="Nazwa" />
                <SubmitButton>Dodaj</SubmitButton>
              </form>
            </div>
          </section>
          )}

          {tab === "drukarka" && isAdmin && <FiscalSettings />}
          {tab === "faktury" && (
          <section id="ksef" className="card scroll-mt-4 p-4">
            <h2 className="h2 mb-1">Faktury i KSeF</h2>
            <p className="mb-3 text-sm text-muted">
              Faktury FM/kolejny/rok wysyłane do KSeF ({ksefEnv() === "prod" ? "produkcja" : ksefEnv()}). Token KSeF (z uprawnieniem do wystawiania faktur) i NIP wpisuje się w Vercel jako
              KSEF_TOKEN i KSEF_NIP – nigdy w czacie. Dane sprzedawcy i numer konta na fakturach: sekcja „Umowy i dane firmy”.
            </p>
            {ksefConfigured()
              ? <form action={testKsefAction}><SubmitButton className="btn-secondary" pendingText="Łączę…">Sprawdź połączenie z KSeF</SubmitButton></form>
              : <Notice>Brak KSEF_TOKEN / KSEF_NIP w ustawieniach serwera.</Notice>}
            <form action={saveInvoiceSettings} className="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" name="auto_email" value="1" defaultChecked={(invoiceSettings?.value as { auto_email?: boolean } | null)?.auto_email !== false} />
                Wysyłaj fakturę (PDF) automatycznie na e-mail nabywcy – po przyjęciu w KSeF, a bez KSeF zaraz po wystawieniu
              </label>
              <SubmitButton className="btn-secondary">Zapisz</SubmitButton>
              {!mail && <span className="text-warn">Najpierw ustaw wysyłkę e-maili niżej.</span>}
            </form>
            <div className="mt-4 space-y-3 border-t border-line pt-4 text-sm">
              <h3 className="font-medium">
                Wysyłka e-maili {mail ? <Pill tone="green">działa z: {mail.from}</Pill> : <Pill tone="red">nie ustawiona</Pill>}
              </h3>
              <p className="text-muted">Skrzynka, z której wychodzą faktury i umowy. Dla OVH: serwer <b>ssl0.ovh.net</b>, port <b>465</b>, login = pełny adres skrzynki, hasło skrzynki.
                Adres nadawcy musi być tą skrzynką albo jej aliasem w OVH. Hasło trafia do zaszyfrowanego sejfu (Supabase Vault) – nie jest nigdzie wyświetlane.</p>
              <form action={saveSmtp} className="grid gap-3 md:grid-cols-3">
                <div><label className="label" htmlFor="smtp-host">Serwer SMTP</label><input id="smtp-host" className="input" name="host" defaultValue={smtp.host ?? "ssl0.ovh.net"} required /></div>
                <div><label className="label" htmlFor="smtp-port">Port</label><input id="smtp-port" className="input" name="port" inputMode="numeric" defaultValue={smtp.port ?? 465} /></div>
                <div><label className="label" htmlFor="smtp-user">Login (adres skrzynki)</label><input id="smtp-user" className="input" type="email" name="user" defaultValue={smtp.user ?? ""} required /></div>
                <div>
                  <label className="label" htmlFor="smtp-pass">Hasło skrzynki</label>
                  <input id="smtp-pass" className="input" type="password" name="password" autoComplete="new-password" placeholder={smtpHasPassword ? "zapisane – wpisz, żeby zmienić" : "hasło do skrzynki"} />
                </div>
                <div><label className="label" htmlFor="smtp-from">Adres nadawcy (puste = login)</label><input id="smtp-from" className="input" type="email" name="from_email" defaultValue={smtp.from_email ?? ""} /></div>
                <div><label className="label" htmlFor="smtp-name">Nazwa nadawcy</label><input id="smtp-name" className="input" name="from_name" defaultValue={smtp.from_name ?? ""} placeholder="np. Sneakers Depot" /></div>
                <div className="flex items-end gap-2 md:col-span-3">
                  <SubmitButton pendingText="Zapisuję…">Zapisz i sprawdź połączenie</SubmitButton>
                  {mail?.source === "env" && <span className="text-xs text-muted">Teraz działa z ustawień w Vercel (SMTP_*). Po zapisaniu tutaj – z tych ustawień.</span>}
                </div>
              </form>
              {mail && (
                <form action={sendTestMailAction} className="flex flex-wrap gap-2">
                  <input className="input w-64" type="email" name="to" placeholder="adres testowy (puste = e-mail firmy)" aria-label="Adres testowy" />
                  <SubmitButton className="btn-secondary" pendingText="Wysyłam…">Wyślij testowy e-mail</SubmitButton>
                </form>
              )}
            </div>
          </section>
          )}

          {tab === "stany" && stock && (
          <section id="sprawdz" className="card space-y-3 p-4">
            <h2 className="h2">Sprawdź produkt: Shopify ↔ Magazyn</h2>
            <p className="text-sm text-muted">Wpisz nazwę albo SKU – zobaczysz stan każdego rozmiaru w Shopify, liczbę sztuk w aplikacji i powód różnicy.</p>
            <form method="get" className="flex flex-wrap gap-2">
              <input type="hidden" name="zakladka" value="stany" />
              <input className="input w-96" name="sprawdz" defaultValue={sp.sprawdz} placeholder="np. Balenciaga Track Black" />
              <button className="btn">Sprawdź</button>
            </form>
            {stock.diag?.data && stock.diag.data.rows.some((r) => r.reasons.length > 0 && r.tracked) && (
              <form action={fixProductStockNow} className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
                <input type="hidden" name="sprawdz" value={sp.sprawdz} />
                {stock.master === "app"
                  ? <span>Są różnice. Główny jest <b>magazyn aplikacji</b> – przycisk ustawi stan tych rozmiarów w Shopify według sztuk w aplikacji (sztuki zostają).</span>
                  : <span>Są różnice. Główny jest <b>Shopify</b> – aplikacja rozdzieli połączone produkty i ustawi liczbę sztuk tych rozmiarów na stan z Shopify (sztuki, których w Shopify nie ma, znikną; komisu nie rusza).</span>}
                <SubmitButton pendingText="Wyrównuję…">{stock.master === "app" ? "Wyślij stan z aplikacji do Shopify" : "Wyrównaj te produkty teraz"}</SubmitButton>
              </form>
            )}
            {stock.diag?.error && <Notice tone="error">{stock.diag.error}</Notice>}
            {stock.diag?.data && (
              <div className="overflow-x-auto">
                {stock.diag.data.errors.map((e) => <p key={e} className="text-sm text-bad">{e}</p>)}
                <table className="table">
                  <thead><tr><th>Sklep · produkt Shopify</th><th>Rozmiar</th><th>Shopify</th><th className="text-right">W aplikacji</th><th>Dlaczego</th></tr></thead>
                  <tbody>
                    {!stock.diag.data.rows.length && <tr><td colSpan={5} className="py-6 text-center text-muted">Shopify nie znalazł takich produktów.</td></tr>}
                    {stock.diag.data.rows.map((r, i) => {
                      const shopQty = r.shopify.filter((x) => x.mapped).reduce((a, x) => a + Math.max(0, x.qty), 0);
                      const diff = r.tracked && shopQty !== r.units;
                      return (
                        <tr key={i} className={diff ? "bg-rose-50" : ""}>
                          <td className="text-sm">{r.store} · {r.product}<span className="block text-xs text-muted">{r.status.toLowerCase()}{r.tags.length ? ` · tagi: ${r.tags.join(", ")}` : ""}</span></td>
                          <td className="text-sm">{r.variant}{r.sku && <span className="block font-mono text-xs text-muted">{r.sku}</span>}</td>
                          <td className="text-sm">{r.shopify.length ? r.shopify.map((x) => <span key={x.location} className={`block ${x.mapped ? "" : "text-warn"}`}>{x.location}: <b>{x.qty}</b>{x.mapped ? "" : " (nieprzypisana)"}</span>) : "–"}</td>
                          <td className="text-right font-semibold tabular-nums">{r.appVariantId ? r.units : "–"}</td>
                          <td className="text-xs">{r.reasons.length ? r.reasons.join(" · ") : <span className="text-ok">zgodne</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          )}

          {tab === "stany" && stock && (
          <section className="card space-y-5 p-4">
            <div>
              <h2 className="h2 mb-1">Główny magazyn</h2>
              <p className="mb-3 text-sm text-muted">Skąd brać stan magazynowy. Teraz: Shopify – nowe stany w sklepie tworzą sztuki w Magazynie (na żywo przez webhooki, co 15 min dla pewności). Docelowo: aplikacja – liczba sztuk na stanie w lokalizacji trafia do Shopify.</p>
              <form action={saveStockMaster} className="space-y-3">
                <div className="inline-flex rounded-full border border-line bg-panel p-1" role="radiogroup" aria-label="Główny magazyn">
                  {(["shopify", "app"] as const).map((m) => (
                    <label key={m} className={`cursor-pointer rounded-full px-4 py-1.5 text-sm transition-colors has-[:checked]:bg-ink has-[:checked]:text-white ${stock.master === m ? "" : "text-muted"}`}>
                      <input type="radio" name="master" value={m} defaultChecked={stock.master === m} className="sr-only" />
                      {m === "shopify" ? "Shopify" : "Magazyn aplikacji"}
                    </label>
                  ))}
                </div>
                <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="confirm" value="1" className="mt-0.5" /> Przy przełączeniu na „Magazyn aplikacji”: rozumiem, że stany w Shopify zostaną nadpisane liczbą sztuk na stanie w aplikacji (najpierw obejrzyj różnice poniżej).</label>
                <SubmitButton>Zapisz</SubmitButton>
              </form>
            </div>
            <div>
              <h3 className="mb-2 font-medium">Lokalizacje Shopify</h3>
              <p className="mb-3 text-sm text-muted">Każda lokalizacja aplikacji wskazuje lokalizację (magazyn) w Shopify swojego sklepu. Sklep z jedną lokalizacją łączy się sam.</p>
              <div className="space-y-2">
                {locations?.filter((l) => l.active).map((l) => {
                  const opts = stock.shopLocs.get(l.store_id);
                  return (
                    <form key={l.id} action={saveShopifyLocation} className="grid items-center gap-2 md:grid-cols-[1fr_1fr_auto]">
                      <input type="hidden" name="id" value={l.id} />
                      <span className="text-sm">{storeName.get(l.store_id)} · <b>{l.name}</b></span>
                      {opts?.data ? (
                        <select className="input" name="shopify_location_id" defaultValue={l.shopify_location_id ?? ""} aria-label={`Lokalizacja Shopify dla ${l.name}`}>
                          <option value="">– bez Shopify –</option>
                          {opts.data.map((o) => <option key={o.id} value={o.id}>{o.name}{o.isActive ? "" : " (nieaktywna)"}</option>)}
                        </select>
                      ) : <span className="text-sm text-bad">{opts?.error ?? "sklep bez domeny Shopify"}</span>}
                      <SubmitButton className="btn-secondary">Zapisz</SubmitButton>
                    </form>
                  );
                })}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
              <form action={runStockNow}><SubmitButton className="btn-secondary" pendingText="Sprawdzam…">Sprawdź stany teraz</SubmitButton></form>
              <Link className="btn-secondary" href="/ustawienia?zakladka=stany&porownaj=1">Porównaj stany: Shopify ↔ aplikacja</Link>
              <Link className="btn-secondary" href="/ustawienia?zakladka=stany&podglad=1">Pokaż różnice: aplikacja → Shopify</Link>
              {stock.last && <span className="text-xs text-muted">Ostatnio: {dateTime(stock.last.created_at)} {stock.last.ok ? "" : "(błąd)"}</span>}
            </div>
            {stock.compare && (stock.compare.error
              ? <Notice tone="error">{stock.compare.error}</Notice>
              : stock.compare.data && (
                <div className="space-y-2">
                  {stock.compare.data.notes.map((n) => <Notice key={n}>{n}</Notice>)}
                  <p className="text-sm">{stock.compare.data.total ? <>Różni się <b>{stock.compare.data.total}</b> rozmiarów (sztuki na stanie w aplikacji vs „dostępne” w Shopify):</> : "Stany w aplikacji i w Shopify są zgodne."}</p>
                  {stock.compare.data.rows.length > 0 && (
                    <div className="max-h-96 overflow-auto rounded-md border border-line">
                      <table className="table text-sm">
                        <thead><tr><th>Sklep</th><th>Produkt</th><th>Rozmiar</th><th className="text-right">Shopify</th><th className="text-right">Aplikacja</th><th>Stan</th></tr></thead>
                        <tbody>
                          {stock.compare.data.rows.map((r, i) => (
                            <tr key={i}>
                              <td className="whitespace-nowrap text-muted">{r.store}</td>
                              <td>{r.title}</td>
                              <td className="font-medium">{r.option}</td>
                              <td className="text-right tabular-nums">{r.shopify}</td>
                              <td className="text-right tabular-nums">{r.app}</td>
                              <td className="text-xs text-muted">{r.waitingSince ? `czeka na potwierdzenie od ${dateTime(r.waitingSince)}` : r.shopify > r.app ? "dojdzie przy odczycie" : "nadmiar w aplikacji (sztuki z historią zostają)"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ))}
            {stock.plan && (stock.plan.error
              ? <Notice tone="error">{stock.plan.error}</Notice>
              : (
                <div className="space-y-2 text-sm">
                  {stock.plan.data?.map((p) => (
                    <div key={p.store.id}>
                      <b>{p.store.name}:</b> {p.note ?? `${p.changes.length} pozycji w Shopify zmieniłoby stan`}
                      {p.changes.length > 0 && <span className="text-muted"> (np. {p.changes.slice(0, 3).map((c) => `${c.changeFromQuantity} → ${c.quantity}`).join(", ")})</span>}
                    </div>
                  ))}
                </div>
              ))}
            {stock.last && !stock.last.ok && <Notice tone="error">{stock.last.message}</Notice>}
            {stock.last && !stock.last.ok && /za dużo na automat/.test(stock.last.message ?? "") && (
              <form action={runStockNow} className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
                <input type="hidden" name="force" value="1" />
                <p>Różnica jest większa niż bezpieczny limit automatu. Jeśli to zamierzone (np. usunięte albo „niekończące się” produkty w Shopify), obejrzyj porównanie i wyrównaj stan jednorazowo:
                  brakujące sztuki dojdą, a nadmiarowe sztuki bez historii znikną (z umową, komisem, dostawą lub sprzedażą zostają).</p>
                <label className="flex items-center gap-2"><input type="checkbox" name="confirm" value="1" /> Obejrzałem porównanie – wyrównaj stan aplikacji do Shopify</label>
                <SubmitButton className="btn-danger" pendingText="Wyrównuję…">Wyrównaj do Shopify teraz</SubmitButton>
              </form>
            )}
            <div className="rounded-md border border-line p-3 text-sm">
              <h3 className="mb-1 font-medium">Dostęp aplikacji do stanów w Shopify</h3>
              <p className="text-muted">Jeśli widzisz „Access denied” albo brak lokalizacji: w <b>dev.shopify.com</b> (Dev Dashboard) → aplikacja sklepu → <b>Versions → Create version</b>, w polu <b>Scopes</b> dopisz
                {" "}<code className="rounded bg-panel px-1">read_locations,read_inventory,write_inventory</code> (zostaw obecne), kliknij <b>Release</b>, a potem w panelu sklepu
                (Ustawienia → Aplikacje → ta aplikacja) zaakceptuj nowe uprawnienia. Osobno dla Telefoniki i Sneakers Depot. Po akceptacji kliknij „Sprawdź stany teraz”.</p>
            </div>
            {stock.purge && (
              <form action={purgeNonShopify} className="space-y-2 border-t border-line pt-4">
                <h3 className="font-medium">Produkty spoza Shopify</h3>
                <p className="text-sm text-muted">
                  Rozmiary bez wariantu w żadnym sklepie Shopify : <b>{stock.purge.units}</b> sztuk do usunięcia, <b>{stock.purge.variants}</b> rozmiarów.
                  {stock.purge.kept > 0 && <> Zostanie <b>{stock.purge.kept}</b> sztuk z historią (umowa, komis, dostawa, sprzedaż) – tych automat nie rusza.</>}
                </p>
                {stock.purge.units + stock.purge.variants > 0 && (
                  <>
                    <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="confirm" value="1" /> Rozumiem – usuń te sztuki i produkty z magazynu aplikacji (Shopify i Base bez zmian).</label>
                    <SubmitButton className="btn-danger" pendingText="Usuwam…">Usuń produkty spoza Shopify</SubmitButton>
                  </>
                )}
              </form>
            )}
          </section>
          )}

          {tab === "wysylka" && sender && (
            <section id="furgonetka" className="card scroll-mt-4 p-4">
              <h2 className="h2 mb-1">Wysyłka i Furgonetka</h2>
              <p className="mb-3 text-sm text-muted">Etykiety InPost i DPD z poziomu zamówienia oraz statusy przesyłek (Wysłane / Dostarczone / Problem).</p>
              <div className="mb-4 flex flex-wrap items-center gap-2">
                {!furgonetkaConfigured() ? (
                  <Notice>
                    Najpierw utwórz aplikację OAuth na <a className="underline" href="https://furgonetka.pl/api/aplikacje-oauth" target="_blank" rel="noreferrer">furgonetka.pl → API → Aplikacje OAuth</a> z adresem przekierowania <code className="rounded bg-panel px-1">{baseUrl}/api/furgonetka/callback</code>,
                    a jej Client ID i Client Secret wpisz w Vercel jako FURGONETKA_CLIENT_ID i FURGONETKA_CLIENT_SECRET.
                  </Notice>
                ) : furgonetka ? (
                  <>
                    <Pill tone="green">połączona</Pill>
                    <span className="text-sm text-muted">sesja ważna do {dateTime(furgonetka.expiresAt)} (odnawia się sama)</span>
                    <a className="btn-secondary" href="/api/furgonetka/polacz">Połącz ponownie</a>
                    <form action={disconnectFurgonetka}><SubmitButton className="btn-secondary">Odłącz</SubmitButton></form>
                  </>
                ) : (
                  <>
                    <Pill tone="red">niepołączona</Pill>
                    <a className="btn" href="/api/furgonetka/polacz">Połącz z Furgonetką</a>
                    <span className="text-xs text-muted">Zalogujesz się na stronie Furgonetki – hasło nie trafia do aplikacji.</span>
                  </>
                )}
              </div>
              <form action={saveSender} className="grid gap-3 md:grid-cols-3">
                <div className="md:col-span-2"><label className="label" htmlFor="s-company">Firma nadawcy</label><input id="s-company" className="input" name="company" defaultValue={sender.company} /></div>
                <div><label className="label" htmlFor="s-name">Osoba kontaktowa</label><input id="s-name" className="input" name="name" defaultValue={sender.name} /></div>
                <div><label className="label" htmlFor="s-street">Ulica i numer</label><input id="s-street" className="input" name="street" defaultValue={sender.street} /></div>
                <div><label className="label" htmlFor="s-postcode">Kod pocztowy</label><input id="s-postcode" className="input" name="postcode" defaultValue={sender.postcode} /></div>
                <div><label className="label" htmlFor="s-city">Miasto</label><input id="s-city" className="input" name="city" defaultValue={sender.city} /></div>
                <div><label className="label" htmlFor="s-email">E-mail</label><input id="s-email" className="input" type="email" name="email" defaultValue={sender.email} /></div>
                <div><label className="label" htmlFor="s-phone">Telefon</label><input id="s-phone" className="input" name="phone" defaultValue={sender.phone} /></div>
                <div><label className="label" htmlFor="s-point">Nadanie InPost (zawsze z punktu)</label><input id="s-point" className="input font-mono" name="inpost_send_point" defaultValue={sender.inpost_send_point} placeholder="any_apm = dowolny paczkomat" /></div>
                <div><label className="label" htmlFor="s-dpd">Nadanie DPD (zawsze z punktu)</label><input id="s-dpd" className="input font-mono" name="dpd_send_point" defaultValue={sender.dpd_send_point} placeholder="any_parcel_shop = dowolny punkt DPD Pickup" /></div>
                <div className="md:col-span-2"><label className="label" htmlFor="s-iban">Konto do wypłat pobrań (opcjonalnie)</label><input id="s-iban" className="input font-mono" name="cod_iban" defaultValue={sender.cod_iban} placeholder="puste = konto ustawione w Furgonetce" /></div>
                <div className="flex items-end"><SubmitButton>Zapisz nadawcę</SubmitButton></div>
              </form>
            </section>
          )}

          {tab === "firma" && company && <ContractSettings company={company} signature={buyerSignature} general={(generalLink?.value as { key?: string; enabled?: boolean }) ?? null} />}

          {tab === "wykluczenia" && (
          <section className="card p-4">
            <h2 className="h2 mb-1">Wykluczenia z magazynu</h2>
            <p className="mb-3 text-sm text-muted">Usługi i produkty, które nie są towarem na sztuki (sznurówki rope, naprawy, mystery boxy). Nie trafiają do katalogu ani do sprzedaży. Na paragonie do zamówienia mają stawkę wybraną przy regule – domyślnie <b>VAT marża</b> (na drukarce stawka {fiscalCfg.ptuMargin}).</p>
            <ul className="mb-3 flex flex-wrap gap-2">
              {exclusions?.map((e) => (
                <li key={e.id} className="flex items-center gap-1 rounded-md border border-line py-1 pl-2.5 pr-1 text-sm">
                  <span className="text-muted">{e.kind === "sku_prefix" ? "SKU od:" : "nazwa zawiera:"}</span>
                  <b>{e.value}</b>
                  <ExclusionVatSelect id={e.id as string} vat={(e as { vat?: string }).vat === "23" ? "23" : "margin"} letters={{ margin: fiscalCfg.ptuMargin, vat23: fiscalCfg.ptuService }} />
                  <form action={setExclusionName} className="ml-1 flex items-center gap-1">
                    <input type="hidden" name="id" value={e.id} />
                    <input name="receipt_name" defaultValue={(e as { receipt_name?: string | null }).receipt_name ?? ""} placeholder="nazwa na paragonie" maxLength={40}
                      className="w-32 rounded border border-line bg-white px-1 py-0.5 text-xs" aria-label={`Nazwa na paragonie dla ${e.value}`} />
                    <button className="rounded px-1 text-xs text-accent hover:bg-panel" aria-label="Zapisz nazwę">✓</button>
                  </form>
                  <form action={deleteExclusion}>
                    <input type="hidden" name="id" value={e.id} />
                    <button className="ml-1 rounded px-1.5 text-muted hover:bg-panel hover:text-bad" aria-label={`Usuń wykluczenie ${e.value}`}>×</button>
                  </form>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-end gap-2">
              <form action={addExclusion} className="flex flex-wrap items-end gap-2">
                <select className="input w-44" name="kind" aria-label="Rodzaj">
                  <option value="sku_prefix">SKU zaczyna się od</option>
                  <option value="title_contains">nazwa zawiera</option>
                </select>
                <input className="input w-64" name="value" placeholder="np. rope albo TF-SRV" aria-label="Wartość" />
                <select className="input w-40" name="vat" aria-label="Stawka na paragonie" defaultValue="margin">
                  <option value="margin">VAT marża ({fiscalCfg.ptuMargin})</option>
                  <option value="23">23% ({fiscalCfg.ptuService})</option>
                </select>
                <SubmitButton className="btn-secondary">Dodaj</SubmitButton>
              </form>
              <form action={purgeExcluded}>
                <SubmitButton className="btn-danger" pendingText="Usuwam…">Usuń wykluczone z magazynu</SubmitButton>
              </form>
            </div>
          </section>
          )}

          {tab === "kopia" && isAdmin && <BackupSettings />}
          {tab === "dziennik" && (
          <section className="card overflow-x-auto p-4">
            <h2 className="h2 mb-3">Dziennik synchronizacji</h2>
            <table className="table">
              <tbody>
                {!logs?.length && <tr><td className="text-muted">Pusto.</td></tr>}
                {logs?.map((l) => (
                  <tr key={l.id}>
                    <td className="whitespace-nowrap text-muted">{dateTime(l.created_at)}</td>
                    <td className="whitespace-nowrap">{l.job}</td>
                    <td><Pill tone={l.ok ? "green" : "red"}>{l.ok ? "ok" : "błąd"}</Pill></td>
                    <td className="font-mono text-xs">{l.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          )}
        </div>
        </div>
      )}
      <p className="mt-6 text-xs text-muted">Sklepy: {[...storeName.values()].join(", ")}</p>
    </>
  );
}
