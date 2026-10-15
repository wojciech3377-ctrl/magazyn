import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Błędy automatu (tabela app_issues, SQL 61): każdy przebieg zgłasza listę problemów swojego źródła.
 * Zgłoszony – otwarty (licznik wystąpień rośnie), niezgłoszony już – zamknięty. Bez SQL 61 – nic się nie dzieje.
 */
export type Issue = { key: string; title: string; detail?: string | null; hint?: string | null; href?: string | null; showAfter?: number };

export async function syncIssues(db: SupabaseClient, source: string, issues: Issue[]) {
  try {
    const now = new Date().toISOString();
    const { data: open, error } = await db.from("app_issues").select("key, count").eq("source", source).is("resolved_at", null);
    if (error) return;
    const openBy = new Map((open ?? []).map((o) => [o.key as string, Number(o.count)]));
    const seen = new Set<string>();
    for (const i of issues) {
      const key = `${source}:${i.key}`.slice(0, 200);
      if (seen.has(key)) continue;
      seen.add(key);
      const row = {
        key, source, title: i.title.slice(0, 300), detail: i.detail?.slice(0, 2000) ?? null, hint: i.hint?.slice(0, 1000) ?? null,
        href: i.href ?? null, show_after: i.showAfter ?? 1, last_seen_at: now,
      };
      if (openBy.has(key)) await db.from("app_issues").update({ ...row, count: openBy.get(key)! + 1 }).eq("key", key);
      // Nowy albo powracający błąd: od nowa (także po wcześniejszym ukryciu).
      else await db.from("app_issues").upsert({ ...row, count: 1, first_seen_at: now, resolved_at: null, dismissed_at: null });
    }
    const gone = [...openBy.keys()].filter((k) => !seen.has(k));
    if (gone.length) await db.from("app_issues").update({ resolved_at: now }).in("key", gone);
  } catch {
    // dziennik błędów nie może zatrzymać automatu
  }
}

export type OpenIssue = { key: string; source: string; title: string; detail: string | null; hint: string | null; href: string | null; count: number; first_seen_at: string; last_seen_at: string };

/** Otwarte, nieukryte błędy (te z progiem – dopiero po kilku wystąpieniach z rzędu). */
export async function openIssues(db: SupabaseClient): Promise<OpenIssue[]> {
  const { data, error } = await db.from("app_issues").select("key, source, title, detail, hint, href, count, show_after, first_seen_at, last_seen_at")
    .is("resolved_at", null).is("dismissed_at", null).order("first_seen_at", { ascending: false }).limit(100);
  if (error) return [];
  return ((data ?? []) as (OpenIssue & { show_after: number })[]).filter((i) => i.count >= i.show_after);
}

const msg = (e: unknown) => (e instanceof Error ? e.message : typeof e === "string" ? e : String((e as { message?: string })?.message ?? e));
const isErr = (v: unknown): v is string => typeof v === "string" && /^błąd/i.test(v);

/** Problemy z jednego przebiegu automatu katalogu i stanów (runAutoCatalog). */
export function catalogIssues(r: {
  catalogError?: string | null; deleted?: unknown; split?: unknown; notInShopify?: unknown; stock?: unknown; collections?: unknown;
}): Issue[] {
  const out: Issue[] = [];
  const stocks = "/ustawienia?zakladka=stany";
  if (r.catalogError) out.push({ key: "katalog", title: "Nie udało się odczytać produktów ze Shopify", detail: r.catalogError, hint: "Nowe i zmienione produkty (ceny, rozmiary) nie trafiają do aplikacji. Sprawdź połączenie ze Shopify w Ustawienia → Połączenia; automat spróbuje ponownie za ok. 20 min.", href: "/ustawienia?zakladka=polaczenia" });
  if (isErr(r.deleted)) out.push({ key: "usuniete", title: "Nie udało się sprawdzić produktów usuniętych w Shopify", detail: r.deleted, hint: "Produkty skasowane w Shopify mogą jeszcze wisieć w Magazynie bez znacznika „brak w Shopify”. Automat spróbuje ponownie przy kolejnym przebiegu." });
  if (isErr(r.split)) out.push({ key: "duplikaty", title: "Nie udało się rozdzielić produktów z tym samym SKU", detail: r.split, hint: "Dwa produkty Shopify z tym samym SKU w jednym sklepie (np. używane pary) liczą się razem – stany tych rozmiarów mogą się nie zgadzać. Ustawienia → Stany → „Sprawdź produkt” pokaże szczegóły.", href: stocks });
  if (typeof r.notInShopify === "string" && r.notInShopify) {
    const many = /najwyżej/i.test(r.notInShopify);
    out.push({
      key: "spoza-shopify",
      title: many ? "Za dużo sztuk do usunięcia naraz (produkty usunięte w Shopify)" : "Nie udało się usunąć sztuk produktów spoza Shopify",
      detail: r.notInShopify,
      hint: many
        ? "Automat usuwa najwyżej 100 sztuk naraz, żeby pomyłka w Shopify (np. chwilowo zniknięty produkt) nie wyczyściła magazynu. Obejrzyj podgląd w Ustawienia → Stany magazynowe i, jeśli wszystko się zgadza, usuń je przyciskiem."
        : "Sztuki produktów skasowanych w Shopify zostają w Magazynie ze znacznikiem „brak w Shopify”.",
      href: stocks,
    });
  }
  const stock = r.stock as { error?: string; master?: string; result?: Record<string, unknown> } | undefined;
  if (stock?.error) out.push({ key: "stany", title: "Porównanie stanów ze Shopify nie powiodło się", detail: stock.error, hint: "Stany w aplikacji nie wyrównują się do Shopify. Sprawdź Ustawienia → Stany magazynowe.", href: stocks });
  for (const [store, v] of Object.entries(stock?.result ?? {})) {
    if (typeof v === "string") {
      const tooMany = /za dużo na automat/i.test(v);
      out.push({
        key: `stany:${store}`,
        title: tooMany ? `${store}: Shopify ma dużo więcej sztuk niż aplikacja – automat wstrzymany` : `${store}: stany nie są porównywane`,
        detail: v.replace(/^błąd:\s*/i, ""),
        hint: tooMany
          ? "Najczęściej to źle przypisana lokalizacja Shopify. Sprawdź Ustawienia → Sklepy i lokalizacje oraz „Porównaj stany”; gdy się zgadza – „Wyrównaj do Shopify teraz”."
          : "Przypisz lokalizacje Shopify do lokalizacji aplikacji (Ustawienia → Sklepy i lokalizacje).",
        href: tooMany ? stocks : "/ustawienia?zakladka=sklepy",
      });
      continue;
    }
    const d = (v ?? {}) as { kept?: number; uwaga?: string; withdrawn?: number; failed?: number; errors?: string[]; left?: number };
    if (d.failed) out.push({
      key: `zapis:${store}`,
      title: `${store}: nie udało się ustawić stanu w Shopify dla ${d.failed} rozmiarów`,
      detail: (d.errors ?? []).join(" · "),
      hint: "Główny jest magazyn aplikacji, więc te rozmiary mogą mieć w Shopify inny stan niż w aplikacji (np. 0 na stronie). Najczęściej rozmiar nie jest aktywny w tej lokalizacji Shopify – włącz go w Shopify (Produkt → Stan magazynowy → lokalizacja).",
      href: stocks,
    });
    if ((d.left ?? 0) > 0) out.push({ key: `zapis-reszta:${store}`, title: `${store}: ${d.left} zmian stanu czeka na kolejny zapis do Shopify`, detail: "Automat zapisuje najwyżej 500 zmian naraz.", hint: "Reszta przejdzie przy kolejnych przebiegach (co ok. 20 min) albo po kliknięciu „Sprawdź nowe produkty i stany”.", showAfter: 3 });
    if ((d.kept ?? 0) > 0) out.push({
      key: `nadmiar:${store}`,
      title: `${store}: ${d.kept} szt. w aplikacji ponad stan w Shopify zostało`,
      detail: "Automat nie usuwa sztuk komisowych, a własnych z historią wycofuje najwyżej 50 na raz.",
      hint: "Sztuki komisowe sprawdź w Magazynie (filtr Własne / komis → Komis) – oddaj komisantowi albo popraw stan w Shopify. Gdy to sztuki własne, kolejne przebiegi wycofają resztę.",
      href: "/magazyn?wlasciciel=consignment",
      showAfter: 2,
    });
    if (d.uwaga) out.push({ key: `obciete:${store}`, title: `${store}: nie wszystkie stany zostały odczytane`, detail: d.uwaga, href: stocks });
  }
  if (typeof r.collections === "string" && isErr(r.collections)) out.push({ key: "kolekcje", title: "Nie udało się pobrać kategorii (kolekcji) ze Shopify", detail: r.collections, hint: "Filtr kategorii w Magazynie może być nieaktualny." });
  for (const [store, v] of Object.entries(r.collections && typeof r.collections === "object" ? r.collections : {})) {
    if (isErr(v)) out.push({ key: `kolekcje:${store}`, title: `${store}: nie udało się pobrać kategorii (kolekcji)`, detail: v, hint: "Filtr kategorii w Magazynie może być nieaktualny. Automat dokończy przy kolejnym przebiegu.", showAfter: 2 });
  }
  return out;
}

/** Problem z zadań co minutę: dopiero po 3 nieudanych przebiegach z rzędu (pojedyncze przerwy Shopify to nie błąd). */
export function fastJobIssue(job: string, error: unknown): Issue {
  const titles: Record<string, [string, string]> = {
    "shopify-orders": ["Zamówienia ze Shopify nie pobierają się", "Nowe zamówienia nie trafiają do Sprzedaży, a sztuki nie dostają rezerwacji. Sprawdź Ustawienia → Połączenia."],
    furgonetka: ["Nie udało się odświeżyć przesyłek Furgonetki", "Statusy wysyłek mogą być nieaktualne. Sprawdź połączenie z Furgonetką w Ustawienia → Wysyłka."],
    ksef: ["Nie udało się sprawdzić statusu faktur w KSeF", "Faktury mogą wisieć jako „w KSeF – przetwarzanie”. Sprawdź Ustawienia → Faktury i KSeF."],
    settle: ["Rozliczanie rezerwacji (sprzedane po paragonie) nie działa", "Sztuki z zamówień z paragonem mogą zostać „zarezerwowane” zamiast „sprzedane”."],
    "consignor-mail": ["E-maile do komisantów o sprzedaży nie wychodzą", "Sprawdź ustawienia poczty (Ustawienia → Faktury i KSeF → SMTP)."],
  };
  const [title, hint] = titles[job] ?? [`Zadanie „${job}” kończy się błędem`, null];
  return { key: job, title, detail: msg(error), hint, showAfter: 3 };
}
