import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { dateTime } from "@/lib/labels";
import { Notice, PageHeader, Pill } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { getInventories, getInventoryWarehouses, getOrderSources } from "@/lib/integrations/base";
import { shopifyCredentials } from "@/lib/integrations/shopify";
import { getBuyerSignature, getCompany } from "@/lib/contracts/settings";
import { mailConfigured } from "@/lib/mail";
import { ContractSettings } from "./ContractSettings";
import { addExclusion, createUser, deleteExclusion, disconnectFurgonetka, importInitialStock, purgeExcluded, registerWebhooks, runStockNow, saveInvoiceSettings, saveLocation, saveSender, saveShopifyLocation, saveStockMaster, saveStore, saveUser } from "./actions";
import { getStockMaster, planPushToShopify, shopifyLocations, type ShopifyLocation } from "@/lib/sync/shopify-stock";
import { furgonetkaConfigured, furgonetkaConnection } from "@/lib/integrations/furgonetka";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSender } from "@/lib/orders/sender";
import { appUrl } from "@/lib/app-url";
import { ksefConfigured, ksefEnv } from "@/lib/ksef/client";
import { testKsefAction } from "../sprzedaz/faktury/actions";
import { errorMessage } from "@/lib/errors";

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
  { key: "wysylka", label: "Wysyłka" },
  { key: "sklepy", label: "Sklepy i lokalizacje" },
  { key: "stany", label: "Stany magazynowe" },
  { key: "wykluczenia", label: "Wykluczenia" },
  { key: "uzytkownicy", label: "Użytkownicy" },
  { key: "start", label: "Start: stany z Base" },
  { key: "dziennik", label: "Dziennik" },
] as const;

export default async function UstawieniaPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const tab = SETTINGS_TABS.find((t) => t.key === sp.zakladka)?.key ?? "polaczenia";
  const { supabase, profile } = await requireProfile();
  const isAdmin = profile.role === "admin";

  const [{ data: stores }, { data: locations }, { data: users }, { data: logs }, { data: imported }, { data: exclusions }] = await Promise.all([
    supabase.from("stores").select("*").order("name"),
    supabase.from("locations").select("*").order("name"),
    supabase.from("profiles").select("*").order("created_at"),
    supabase.from("sync_log").select("*").order("created_at", { ascending: false }).limit(15),
    supabase.from("sync_state").select("value").eq("key", "initial_stock_imported").maybeSingle(),
    supabase.from("catalog_exclusions").select("id, kind, value").order("created_at"),
  ]);
  const [company, buyerSignature, { data: generalLink }] = isAdmin
    ? await Promise.all([getCompany(supabase), getBuyerSignature(supabase), supabase.from("app_settings").select("value").eq("key", "general_contract_link").maybeSingle()])
    : [null, null, { data: null }];
  const [sender, furgonetka, baseUrl] = isAdmin
    ? await Promise.all([getSender(supabase), furgonetkaConfigured() ? furgonetkaConnection(createAdminClient()) : Promise.resolve(null), appUrl()])
    : [null, null, ""];
  const hasBase = !!process.env.BASE_API_TOKEN;
  const [inventories, warehouses, sources] = isAdmin && hasBase
    ? await Promise.all([safe(getInventories), safe(getInventoryWarehouses), safe(getOrderSources)])
    : [{ data: null, error: null }, { data: null, error: null }, { data: null, error: null }];
  const shopSources = Object.entries(sources.data?.shop ?? {});
  const preview = isAdmin && !imported ? (await supabase.rpc("preview_initial_stock")).data as { units: number; variants: number } | null : null;
  const storeName = new Map((stores ?? []).map((s) => [s.id, s.name]));
  // Stany: główne źródło, lokalizacje Shopify i (na żądanie) podgląd różnic.
  const stock = isAdmin && tab === "stany"
    ? await (async () => {
        const db = createAdminClient();
        const master = await getStockMaster(db);
        const shopLocs = new Map<string, { data: ShopifyLocation[] | null; error: string | null }>();
        for (const st of (stores ?? []).filter((x) => x.shopify_domain)) shopLocs.set(st.id, await safe(() => shopifyLocations(st.shopify_domain as string, st.code as string)));
        const plan = sp.podglad === "1" ? await safe(() => planPushToShopify(db)) : null;
        const { data: last } = await db.from("sync_log").select("job, ok, message, created_at").in("job", ["stock", "auto-catalog"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
        return { master, shopLocs, plan, last };
      })()
    : null;
  const { data: invoiceSettings } = isAdmin && tab === "faktury" ? await supabase.from("app_settings").select("value").eq("key", "invoices").maybeSingle() : { data: null };

  const envStatus = [
    ["Supabase (klucz serwera)", !!process.env.SUPABASE_SERVICE_ROLE_KEY],
    ["Base API", hasBase],
    ...(stores ?? []).map((s) => {
      const c = shopifyCredentials(s.code);
      return [`Shopify ${s.name}`, !!(c.clientId && c.clientSecret)] as [string, boolean];
    }),
    ["Zadanie cykliczne (CRON_SECRET)", !!process.env.CRON_SECRET],
    ["E-mail (SMTP)", mailConfigured()],
    ["Furgonetka (klucze aplikacji)", furgonetkaConfigured()],
    [`KSeF (${ksefEnv()})`, ksefConfigured()],
  ] as [string, boolean][];
  const missing = envStatus.filter(([, ok]) => !ok).length;

  return (
    <>
      <PageHeader title="Ustawienia" />
      {sp.ok && <div className="mb-4"><Notice tone="ok">{sp.ok}</Notice></div>}
      {sp.blad && <div className="mb-4"><Notice tone="error">{sp.blad}</Notice></div>}
      {!isAdmin && <Notice>Ustawienia zmienia administrator.</Notice>}

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
            {[inventories.error, warehouses.error, sources.error].filter(Boolean).slice(0, 1).map((e) => <div key={e} className="mt-3"><Notice tone="error">{e}</Notice></div>)}
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
                  <div>
                    <label className="label">Katalog w Base</label>
                    {inventories.data ? (
                      <select className="input" name="base_inventory_id" defaultValue={s.base_inventory_id ?? ""}>
                        <option value="">–</option>
                        {inventories.data.map((i) => <option key={i.inventory_id} value={i.inventory_id}>{i.name} ({i.inventory_id})</option>)}
                      </select>
                    ) : <input className="input" name="base_inventory_id" defaultValue={s.base_inventory_id ?? ""} placeholder="ID katalogu" />}
                  </div>
                  <div>
                    <label className="label">Źródło zamówień w Base</label>
                    {shopSources.length ? (
                      <select className="input" name="base_order_source_id" defaultValue={s.base_order_source_id ?? ""}>
                        <option value="">–</option>
                        {shopSources.map(([id, name]) => <option key={id} value={id}>{name} ({id})</option>)}
                      </select>
                    ) : <input className="input" name="base_order_source_id" defaultValue={s.base_order_source_id ?? ""} placeholder="ID źródła" />}
                  </div>
                  <div><label className="label">Sklep w katalogu Base (wykrywany automatycznie)</label><input className="input" name="base_storage_id" defaultValue={s.base_storage_id ?? ""} placeholder="shop_1234" /></div>
                  <div className="flex flex-wrap gap-2">
                    <SubmitButton>Zapisz</SubmitButton>
                    <SubmitButton className="btn-secondary" formAction={registerWebhooks} pendingText="Rejestruję…">Włącz na żywo: produkty, zamówienia, stany</SubmitButton>
                  </div>
                </form>
              ))}
            </div>
          </section>
          )}

          {tab === "sklepy" && (
          <section className="card p-4">
            <h2 className="h2 mb-1">Lokalizacje</h2>
            <p className="mb-3 text-sm text-muted">Każda lokalizacja należy do sklepu i wskazuje magazyn w Base, którego stan aplikacja zmienia.</p>
            <div className="space-y-2">
              {locations?.map((l) => (
                <form key={l.id} action={saveLocation} className="grid items-end gap-2 md:grid-cols-[1fr_1fr_1fr_auto_auto]">
                  <input type="hidden" name="id" value={l.id} />
                  <select className="input" name="store_id" defaultValue={l.store_id} aria-label="Sklep">
                    {stores?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  <input className="input" name="name" defaultValue={l.name} aria-label="Nazwa" />
                  <WarehouseSelect warehouses={warehouses.data} value={l.base_warehouse_id} />
                  <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" name="active" defaultChecked={l.active} /> aktywna</label>
                  <SubmitButton className="btn-secondary">Zapisz</SubmitButton>
                </form>
              ))}
              <form action={saveLocation} className="grid items-end gap-2 border-t border-line pt-3 md:grid-cols-[1fr_1fr_1fr_auto]">
                <select className="input" name="store_id" aria-label="Sklep">
                  {stores?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <input className="input" name="name" placeholder="Nowa lokalizacja, np. Poznań – Długa 13" aria-label="Nazwa" />
                <WarehouseSelect warehouses={warehouses.data} value={null} />
                <SubmitButton>Dodaj</SubmitButton>
              </form>
            </div>
          </section>
          )}

          {tab === "faktury" && (
          <section id="ksef" className="card scroll-mt-4 p-4">
            <h2 className="h2 mb-1">Faktury i KSeF</h2>
            <p className="mb-3 text-sm text-muted">
              Faktury FVM/kolejny/rok wysyłane do KSeF ({ksefEnv() === "prod" ? "produkcja" : ksefEnv()}). Token KSeF (z uprawnieniem do wystawiania faktur) i NIP wpisuje się w Vercel jako
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
              {!mailConfigured() && <span className="text-warn">Najpierw ustaw SMTP w Vercel (SMTP_HOST, SMTP_USER, SMTP_PASS).</span>}
            </form>
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
              <Link className="btn-secondary" href="/ustawienia?zakladka=stany&podglad=1">Pokaż różnice: aplikacja → Shopify</Link>
              {stock.last && <span className="text-xs text-muted">Ostatnio: {dateTime(stock.last.created_at)} {stock.last.ok ? "" : "(błąd)"}</span>}
            </div>
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
            <p className="text-xs text-muted">Aplikacja sklepu w Shopify potrzebuje uprawnień read_locations, read_inventory i – dla „Magazyn aplikacji” – write_inventory.</p>
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
                <div><label className="label" htmlFor="s-point">Nadanie InPost</label><input id="s-point" className="input font-mono" name="inpost_send_point" defaultValue={sender.inpost_send_point} placeholder="any_apm = dowolny paczkomat" /></div>
                <div className="md:col-span-2"><label className="label" htmlFor="s-iban">Konto do wypłat pobrań (opcjonalnie)</label><input id="s-iban" className="input font-mono" name="cod_iban" defaultValue={sender.cod_iban} placeholder="puste = konto ustawione w Furgonetce" /></div>
                <div className="flex items-end"><SubmitButton>Zapisz nadawcę</SubmitButton></div>
              </form>
            </section>
          )}

          {tab === "firma" && company && <ContractSettings company={company} signature={buyerSignature} general={(generalLink?.value as { key?: string; enabled?: boolean }) ?? null} />}

          {tab === "wykluczenia" && (
          <section className="card p-4">
            <h2 className="h2 mb-1">Wykluczenia z magazynu</h2>
            <p className="mb-3 text-sm text-muted">Usługi i produkty, które nie są towarem na sztuki (naprawy, mystery boxy). Nie trafiają do katalogu ani do sprzedaży; ich stan zostaje tylko w Base.</p>
            <ul className="mb-3 flex flex-wrap gap-2">
              {exclusions?.map((e) => (
                <li key={e.id}>
                  <form action={deleteExclusion} className="flex items-center gap-1 rounded-md border border-line py-1 pl-2.5 pr-1 text-sm">
                    <input type="hidden" name="id" value={e.id} />
                    <span className="text-muted">{e.kind === "sku_prefix" ? "SKU od:" : "nazwa zawiera:"}</span>
                    <b>{e.value}</b>
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
                <input className="input w-64" name="value" placeholder="np. TF-SRV albo mystery box" aria-label="Wartość" />
                <SubmitButton className="btn-secondary">Dodaj</SubmitButton>
              </form>
              <form action={purgeExcluded}>
                <SubmitButton className="btn-danger" pendingText="Usuwam…">Usuń wykluczone z magazynu</SubmitButton>
              </form>
            </div>
          </section>
          )}

          {tab === "start" && (
          <section className="card p-4">
            <h2 className="h2 mb-1">Start: stany z Base</h2>
            {imported ? (
              <p className="text-sm text-muted">Wgrane {dateTime((imported.value as { at: string }).at)} · {(imported.value as { units: number }).units} sztuk.</p>
            ) : (
              <form action={importInitialStock} className="space-y-2">
                <p className="text-sm text-muted">
                  Jednorazowo: każdy rozmiar ze stanem N w Base staje się N sztukami „bez umowy”. Najpierw zrób import z Shopify i katalog Base w zakładce Katalog
                  oraz przypisz magazyny Base do lokalizacji. Teraz wejdzie: <b>{preview?.units ?? 0} sztuk</b> ({preview?.variants ?? 0} pozycji).
                </p>
                <SubmitButton pendingText="Wgrywam…" disabled={!preview?.units}>Wgraj stany z Base</SubmitButton>
              </form>
            )}
          </section>
          )}

          {tab === "uzytkownicy" && (
          <section className="card overflow-x-auto p-4">
            <h2 className="h2 mb-3">Użytkownicy</h2>
            <table className="table">
              <thead><tr><th>E-mail</th><th>Imię</th><th>Rola</th><th>Widzi ceny</th><th>Aktywny</th><th /></tr></thead>
              <tbody>
                {users?.map((u) => (
                  <tr key={u.id}>
                    <td>{u.email}</td>
                    <td colSpan={5}>
                      <form action={saveUser} className="flex flex-wrap items-center gap-3">
                        <input type="hidden" name="id" value={u.id} />
                        <input className="input w-40 py-1" name="full_name" defaultValue={u.full_name ?? ""} aria-label="Imię" />
                        <select className="input w-36 py-1" name="role" defaultValue={u.role} aria-label="Rola">
                          <option value="staff">pracownik</option>
                          <option value="admin">administrator</option>
                        </select>
                        <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" name="can_see_prices" defaultChecked={u.can_see_prices} /> ceny zakupu</label>
                        <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" name="active" defaultChecked={u.active} /> aktywny</label>
                        <SubmitButton className="btn-secondary py-1">Zapisz</SubmitButton>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <form action={createUser} className="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-3">
              <input className="input w-64" type="email" name="email" placeholder="e-mail pracownika" aria-label="E-mail" />
              <input className="input w-56" type="text" name="password" placeholder="hasło startowe (min. 10 znaków)" aria-label="Hasło startowe" autoComplete="off" />
              <SubmitButton>Dodaj konto</SubmitButton>
            </form>
          </section>
          )}

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

function WarehouseSelect({ warehouses, value }: { warehouses: { id: string; name: string }[] | null; value: string | null }) {
  if (!warehouses) return <input className="input" name="base_warehouse_id" defaultValue={value ?? ""} placeholder="magazyn Base, np. bl_123" aria-label="Magazyn Base" />;
  return (
    <select className="input" name="base_warehouse_id" defaultValue={value ?? ""} aria-label="Magazyn Base">
      <option value="">bez magazynu Base</option>
      {warehouses.filter((w) => w.id.startsWith("bl_")).map((w) => <option key={w.id} value={w.id}>{w.name} ({w.id})</option>)}
    </select>
  );
}
