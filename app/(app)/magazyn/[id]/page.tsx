import { freeContracts } from "@/lib/contracts/free";
import { OwnerFields } from "./OwnerFields";
import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { productImages } from "@/lib/product-images";
import { ProductGallery } from "@/components/ProductGallery";
import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { UNIT_SELECT, type UnitRow } from "@/lib/queries/units";
import { describeEvent, type HistoryEvent } from "@/lib/history";
import { CONTRACT_TYPE, dateOnly, dateTime, EVENT_TYPE, money, PURCHASE_FORM, SALE_STATUS, UNIT_STATUS } from "@/lib/labels";
import { Field, Notice, PageHeader, Pill, StatusBadge } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { alignUnitNow, assignUnitToShopify, changeStatus, deleteUnit, updateUnit } from "../actions";
import { VariantPick } from "@/components/VariantPick";
import { diagnoseUnitStock } from "@/lib/unit-stock";
import { errorMessage } from "@/lib/errors";
import { expectedPrices } from "@/lib/contracts/inherit-price";
import { shopifyMatches, type ShopifyMatch } from "@/lib/unassigned";

const NEXT_STATUS: Record<string, { to: string; label: string; danger?: boolean }[]> = {
  in_transit: [{ to: "in_stock", label: "Przyjmij na stan" }],
  in_stock: [
    { to: "reserved", label: "Zarezerwuj (−1 w Shopify)" },
    { to: "out", label: "Wydaj poza sklepem (rzecz znika z magazynu, umowa – do niewykorzystanych)", danger: true },
    { to: "in_transit", label: "Cofnij do „w drodze”" },
  ],
  reserved: [{ to: "in_stock", label: "Zdejmij rezerwację" }, { to: "out", label: "Wydaj poza sklepem (rzecz znika z magazynu, umowa – do niewykorzystanych)", danger: true }],
  sold: [{ to: "shipped", label: "Oznacz jako wysłaną" }, { to: "return_to_stock", label: "Zwrot – wraca na stan" }, { to: "returned", label: "Zwrot – do sprawdzenia" }],
  shipped: [{ to: "return_to_stock", label: "Zwrot – wraca na stan" }, { to: "returned", label: "Zwrot – do sprawdzenia" }],
  returned: [{ to: "in_stock", label: "Przywróć na stan" }],
};

export default async function UnitPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const { supabase, profile } = await requireProfile();

  const { data } = await supabase.from("units").select(UNIT_SELECT).eq("id", id).maybeSingle();
  if (!data) notFound();
  const u = data as unknown as UnitRow;

  // Wszystko, co zależy tylko od sztuki – równolegle (wcześniej kilka zapytań po kolei).
  const [{ data: events }, { data: sales }, { data: contracts }, { data: consignors }, { data: contract }, { data: mates }, { data: prodFlags }, images, shopDiag] = await Promise.all([
    supabase.from("unit_events").select("id, type, data, created_at").eq("unit_id", id).order("created_at", { ascending: false }),
    supabase.from("sales").select("id, order_ref, status, sold_at, product_name").eq("unit_id", id).order("sold_at", { ascending: false }),
    // Tylko wolne umowy (zajęta – ma już swoją rzecz) i ta przypięta do tej sztuki.
    freeContracts(supabase, { keep: [u.contract_id] }).then((data) => ({ data })),
    supabase.from("consignors").select("id, name").order("name"),
    u.contract_id ? supabase.from("contracts").select("*").eq("id", u.contract_id).single() : Promise.resolve({ data: null }),
    // Kwota z umowy dla tej sztuki – porównanie z kwotą zakupu w magazynie.
    u.contract_id ? supabase.from("units").select("id, variant_id").eq("contract_id", u.contract_id) : Promise.resolve({ data: null }),
    // Produkt spoza katalogu Shopify (z paczki komisanta / linku ogólnego) – do ręcznego przypisania.
    supabase.from("products").select("*").eq("id", u.variant.product.id).maybeSingle(),
    productImages(createAdminClient(), u.variant.product.id, u.location.store_id, u.variant.product.image_url).catch(() => []),
    // „Sprawdź stan w Shopify” – na żywo, tylko na żądanie (zapytanie do Shopify).
    sp.shopify === "1" ? diagnoseUnitStock(createAdminClient(), u.id).catch((e) => ({ levels: [], reasons: [], product: null, canAlign: false, master: "shopify" as const, error: errorMessage(e) })) : Promise.resolve(null),
  ]);
  // Waluta kwot: z umowy, a bez umowy – zapisana przy przyjęciu (SQL 67).
  const { data: curRow } = await supabase.from("units").select("*").eq("id", u.id).maybeSingle().then((r) => r, () => ({ data: null }));
  // Kwota w Magazynie – w walucie sztuki (wpisanej); bez niej – w walucie umowy (sztuki utworzone z umowy).
  const curCode = (curRow as { purchase_currency?: string | null } | null)?.purchase_currency ?? (contract?.currency as string | null | undefined) ?? null;
  const cur = curCode && curCode !== "PLN" ? curCode : null;
  const inCur = (n: number) => money(n, curCode);
  const inContractCur = (n: number) => money(n, (contract?.currency as string | null | undefined) ?? null);
  const fromContract = contract && mates ? expectedPrices(contract, mates as { id: string; variant_id: string }[]).expected.get(u.id) : undefined;
  const ownPrice = u.owner_type === "consignment" ? u.payout_amount : u.purchase_price;
  const priceDiff = fromContract !== undefined && ownPrice !== null && ownPrice !== undefined && Math.abs(Number(ownPrice) - fromContract) >= 0.005;

  const unassigned = !!(prodFlags as { unassigned?: boolean } | null)?.unassigned;
  // Nieprzypisana: inne sztuki tego samego produktu (przypisanie hurtem) i podobne produkty z Shopify.
  const [siblingsRes, matches] = unassigned
    ? await Promise.all([
      supabase.from("units").select("id, variant:variants!inner(product_id)", { count: "exact", head: true }).eq("variant.product_id", u.variant.product.id).neq("id", u.id),
      shopifyMatches(supabase, u.variant.product.title, u.variant.option, u.location.store_id).catch(() => [] as ShopifyMatch[]),
    ])
    : [{ count: 0 }, [] as ShopifyMatch[]];
  const siblings = siblingsRes.count ?? 0;
  let fileUrl: string | null = null;
  if (contract?.file_path) {
    const { data: signed } = await supabase.storage.from("contracts").createSignedUrl(contract.file_path, 600);
    fileUrl = signed?.signedUrl ?? null;
  }

  return (
    <>
      <PageHeader
        back="/magazyn"
        title={`${u.variant.product.title} · ${u.variant.option}`}
        sub={<span className="font-mono">{u.code}{u.identifier ? ` · ${u.identifier}` : ""}</span>}
        actions={
          <>
            <Link className="btn-secondary" href={`/etykiety?ids=${u.id}`} target="_blank">Drukuj etykietę</Link>
            <a className="btn-secondary" href={`/metka?ids=${u.id}`} target="_blank" rel="noreferrer">Wydrukuj metkę</a>
            <Link className="btn-secondary" href="/magazyn">Wróć do listy</Link>
          </>
        }
      />
      {sp.ok && <div className="mb-4"><Notice tone="ok">{sp.ok}</Notice></div>}
      {sp.blad && <div className="mb-4"><Notice tone="error">{sp.blad}</Notice></div>}
      {unassigned && (
        <section className="card mb-5 border-orange-300 bg-orange-50/50 p-4">
          <h2 className="h2 mb-1">Nieprzypisany do Shopify</h2>
          <p className="mb-3 text-sm text-muted">Tej rzeczy nie było w katalogu („{u.variant.product.title} · {u.variant.option}”). Nie ma jej w Shopify, więc nie ma ceny ani stanu w sklepie. Wybierz produkt i rozmiar z katalogu – sztuka się z nim połączy{u.status === "in_stock" ? ", a stan w Shopify wzrośnie o 1" : ""}. Nowego produktu? Dodaj go najpierw w Shopify – po odczycie katalogu (co 15 min albo „Sprawdź nowe produkty i stany” w Magazynie) pojawi się niżej jako podobny.</p>
          {matches.length > 0 && (
            <div className="mb-4">
              <div className="label">Podobne produkty w Shopify</div>
              <ul className="divide-y divide-line rounded-lg border border-line bg-white">
                {matches.map((m) => (
                  <li key={m.productId} className="flex flex-wrap items-center gap-3 p-2">
                    {m.image ? <img src={m.image} alt="" className="h-10 w-10 rounded object-cover" /> : <span className="h-10 w-10 rounded bg-panel" />}
                    <span className="min-w-0 flex-1 text-sm">{m.title}<span className="block text-xs text-muted">{m.sameSize ? `rozmiar ${m.sameSize.option} jest w Shopify` : `brak rozmiaru ${u.variant.option} w tym produkcie`}</span></span>
                    {m.sameSize && (
                      <form action={assignUnitToShopify}>
                        <input type="hidden" name="id" value={u.id} />
                        <input type="hidden" name="variant_id" value={m.sameSize.id} />
                        {siblings > 0 && <input type="hidden" name="all" value="1" />}
                        <SubmitButton className="btn-secondary" pendingText="Łączę…">{siblings > 0 ? `Połącz (${siblings + 1} szt., po rozmiarach)` : "Połącz"}</SubmitButton>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <form action={assignUnitToShopify} className="max-w-xl space-y-2">
            <input type="hidden" name="id" value={u.id} />
            <VariantPick name="variant_id" storeId={u.location.store_id} label={matches.length ? "Albo wybierz inny produkt z katalogu" : "Produkt z katalogu"} />
            {siblings > 0 && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="all" value="1" defaultChecked />
                przypisz też pozostałe {siblings} szt. „{u.variant.product.title}” (każdą do swojego rozmiaru)
              </label>
            )}
            <SubmitButton pendingText="Przypisuję…">Przypisz do produktu z Shopify</SubmitButton>
          </form>
        </section>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="min-w-0 space-y-5 lg:col-span-2">
          <section className="card p-4">
            <div className="mb-4"><ProductGallery images={images} title={u.variant.product.title} /></div>
            <div className="mb-4 flex items-center gap-3">
              <div className="text-sm">
                <div>SKU modelu: <b>{u.variant.product.style_sku ?? "–"}</b></div>
                <div className="text-muted">{u.location.store.name} · {u.location.name}</div>
              </div>
              <div className="ml-auto"><StatusBadge status={u.status} /></div>
            </div>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <Field label="Przyjęta">{dateTime(u.received_at)}</Field>
              <Field label="Sprzedana">{dateTime(u.sold_at)}</Field>
              <Field label="Cena w sklepie">{money(u.variant.links.find((l) => l.store_id === u.location.store_id && l.price !== null)?.price ?? u.variant.links.find((l) => l.price !== null)?.price ?? null)}</Field>
              <Field label="Forma sprzedaży">{PURCHASE_FORM[u.purchase_form]}</Field>
              <Field label="Właściciel">{u.owner_type === "consignment" ? `komis · ${u.consignor?.name}` : "własna"}</Field>
              {profile.can_see_prices && <Field label="Cena zakupu">{u.purchase_price === null ? "–" : inCur(Number(u.purchase_price))}</Field>}
              {profile.can_see_prices && u.owner_type === "consignment" && <Field label="Cena w komisie">{u.payout_amount === null ? "–" : inCur(Number(u.payout_amount))}</Field>}
            </div>
          </section>

          <section id="shopify" className="card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="h2">Stan w Shopify</h2>
              <Link className="btn-secondary px-3 py-1.5 text-sm" href={`/magazyn/${u.id}?shopify=1#shopify`} scroll={false}>{shopDiag ? "Sprawdź ponownie" : "Sprawdź stan w Shopify"}</Link>
            </div>
            {!shopDiag && <p className="mt-1 text-sm text-muted">Pokaże stan tego rozmiaru w Shopify na żywo i wyjaśni, dlaczego sztuka jest (albo nie jest) w magazynie.</p>}
            {shopDiag?.error && <p className="mt-2 text-sm text-bad">{shopDiag.error}</p>}
            {shopDiag && shopDiag.levels.length > 0 && (
              <div className="mt-3 overflow-x-auto">
                <table className="table text-sm">
                  <thead><tr><th>Lokalizacja Shopify</th><th className="text-right">Dostępne</th><th className="text-right">W zamówieniach</th><th className="text-right">Na stanie w aplikacji</th></tr></thead>
                  <tbody>
                    {shopDiag.levels.map((l) => (
                      <tr key={l.location} className={l.mine ? "bg-sky-50" : ""}>
                        <td>{l.location}{l.mine && <span className="ml-1 text-xs text-muted">(lokalizacja tej sztuki)</span>}{!l.online && <span className="ml-1 text-xs text-warn">nie sprzedaje online</span>}{!l.mapped && <span className="ml-1 text-xs text-muted">nieprzypisana w aplikacji</span>}</td>
                        <td className="text-right tabular-nums">{l.available}</td>
                        <td className="text-right tabular-nums">{l.committed}</td>
                        <td className="text-right tabular-nums">{l.app ?? "–"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {shopDiag.product && <p className="mt-1 text-xs text-muted">Produkt w Shopify: {shopDiag.product.status === "ACTIVE" ? "aktywny" : shopDiag.product.status === "DRAFT" ? "wersja robocza" : shopDiag.product.status === "ARCHIVED" ? "zarchiwizowany" : shopDiag.product.status}{shopDiag.product.url ? <> · <a className="text-accent hover:underline" href={shopDiag.product.url} target="_blank" rel="noreferrer">strona w sklepie</a></> : " · nieopublikowany w sklepie internetowym"}</p>}
              </div>
            )}
            {shopDiag && shopDiag.reasons.length > 0 && (
              <ul className="mt-3 space-y-1.5 text-sm">
                {shopDiag.reasons.map((r, k) => <li key={k} className={r.tone === "bad" ? "text-bad" : r.tone === "warn" ? "text-warn" : ""}>• {r.text}</li>)}
              </ul>
            )}
            {shopDiag?.canAlign && profile.role === "admin" && (
              <form action={alignUnitNow} className="mt-3">
                <input type="hidden" name="id" value={u.id} />
                <SubmitButton className="btn-secondary" pendingText="Wyrównuję…">{shopDiag.master === "app" ? "Wyślij stan tego rozmiaru do Shopify" : "Wyrównaj ten rozmiar do Shopify teraz"}</SubmitButton>
              </form>
            )}
          </section>

          <section className="card p-4">
            <h2 className="h2 mb-3">Edycja</h2>
            <form action={updateUnit} className="grid gap-3 md:grid-cols-2">
              <input type="hidden" name="id" value={u.id} />
              <div>
                <label className="label" htmlFor="identifier">IMEI / numer seryjny</label>
                <input className="input" id="identifier" name="identifier" defaultValue={u.identifier ?? ""} />
              </div>
              <div>
                <label className="label" htmlFor="shelf">Regał / półka</label>
                <input className="input" id="shelf" name="shelf" defaultValue={u.shelf ?? ""} />
              </div>
              {curRow && "supplier" in curRow && (
                <div>
                  <label className="label" htmlFor="supplier">Od kogo</label>
                  <input className="input" id="supplier" name="supplier" maxLength={120} defaultValue={(curRow as { supplier?: string | null }).supplier ?? ""} placeholder={contract?.counterparty ?? "sprzedający / dostawca"} />
                </div>
              )}
              <OwnerFields ownerType={u.owner_type} consignorId={u.consignor?.id ?? null} consignors={(consignors ?? []) as { id: string; name: string }[]} />
              <div>
                <label className="label" htmlFor="purchase_form">Forma sprzedaży</label>
                <select className="input" id="purchase_form" name="purchase_form" defaultValue={u.purchase_form}>
                  <option value="vat_margin">VAT marża</option>
                  <option value="vat_23">23% VAT</option>
                </select>
              </div>
              <div>
                <label className="label" htmlFor="contract_id">Umowa</label>
                <select className="input" id="contract_id" name="contract_id" defaultValue={u.contract_id ?? ""}>
                  <option value="">brak umowy</option>
                  {contracts?.map((c) => <option key={c.id} value={c.id}>{c.label}{c.contract_date ? ` · ${dateOnly(c.contract_date)}` : ""}</option>)}
                </select>
              </div>
              {profile.can_see_prices && (
                <>
                  <div>
                    <label className="label" htmlFor="purchase_price">Cena zakupu</label>
                    <span className="relative block">
                      <input className="input pr-12 tabular-nums" id="purchase_price" name="purchase_price" inputMode="decimal" defaultValue={u.purchase_price ?? ""} />
                      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted">{cur ?? "zł"}</span>
                    </span>
                  </div>
                  <div>
                    <label className="label" htmlFor="payout_amount">Cena w komisie</label>
                    <span className="relative block">
                      <input className="input pr-12 tabular-nums" id="payout_amount" name="payout_amount" inputMode="decimal" defaultValue={u.payout_amount ?? ""} />
                      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted">{cur ?? "zł"}</span>
                    </span>
                  </div>
                  {/* Waluta kwot w Magazynie (JPK bierze kwotę i walutę z umowy). */}
                  <div>
                    <label className="label" htmlFor="purchase_currency">Waluta kwot</label>
                    <select className="input" id="purchase_currency" name="purchase_currency" defaultValue={curCode ?? "PLN"}>
                      <option value="PLN">PLN – złoty</option>
                      <option value="EUR">EUR – euro</option>
                    </select>
                  </div>
                </>
              )}
              <div className="md:col-span-2">
                <label className="label" htmlFor="notes">Notatki</label>
                <textarea className="input" id="notes" name="notes" rows={2} defaultValue={u.notes ?? ""} />
              </div>
              <div className="md:col-span-2"><SubmitButton>Zapisz zmiany</SubmitButton></div>
            </form>
          </section>

          <section className="card p-4">
            <h2 className="h2 mb-3">Historia</h2>
            <ol className="space-y-2 text-sm">
              {events?.map((e) => (
                <li key={e.id} className="flex gap-3">
                  <span className="w-32 shrink-0 text-muted">{dateTime(e.created_at)}</span>
                  {(() => { const d = describeEvent(e as HistoryEvent); return <span><b className="font-medium">{d.title}</b>{d.detail && <span className="text-muted"> · {d.detail}</span>}</span>; })()}
                </li>
              ))}
            </ol>
          </section>
        </div>

        <div className="min-w-0 space-y-5">
          <section className="card p-4">
            <h2 className="h2 mb-3">Umowa</h2>
            {contract ? (
              <div className="space-y-2 text-sm">
                <div><Link className="font-medium text-accent hover:underline" href={`/umowy/${contract.id}`}>{contract.counterparty}</Link></div>
                <div className="text-muted">{CONTRACT_TYPE[contract.type]} · {dateOnly(contract.contract_date)}</div>
                {profile.can_see_prices && fromContract !== undefined && <div>Kwota w umowie dla tej sztuki (idzie do JPK): <b className="tabular-nums">{inContractCur(fromContract)}</b></div>}
                {profile.can_see_prices && priceDiff && (
                  <p className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
                    W Magazynie {u.owner_type === "consignment" ? "kwota komisanta" : "cena zakupu"} to <b>{inCur(Number(ownPrice))}</b> – zostaje bez zmian. W JPK jako kwota zakupu idzie kwota z umowy: <b>{inContractCur(fromContract!)}</b>.
                  </p>
                )}
                {fileUrl ? <a className="btn-secondary w-full" href={fileUrl} target="_blank" rel="noreferrer">Otwórz plik umowy</a> : <Pill tone="amber">bez pliku</Pill>}
              </div>
            ) : (
              <div className="space-y-3 text-sm">
                <Pill tone="red">brak umowy</Pill>
                <p className="text-muted">Wybierz umowę w edycji albo <Link className="text-accent underline" href={`/umowy/nowa?sztuki=${u.code}`}>dodaj nową umowę dla tej sztuki</Link>.</p>
              </div>
            )}
          </section>

          <section className="card p-4">
            <h2 className="h2 mb-3">Status</h2>
            <div className="flex flex-col gap-2">
              {(NEXT_STATUS[u.status] ?? []).map((s) => (
                <form key={s.to} action={changeStatus}>
                  <input type="hidden" name="id" value={u.id} />
                  <input type="hidden" name="to" value={s.to} />
                  <SubmitButton className="btn-secondary h-auto w-full whitespace-normal py-2 text-center leading-snug" pendingText="Zmieniam…">{s.label}</SubmitButton>
                </form>
              ))}
            </div>
          </section>

          {sales && sales.length > 0 && (
            <section className="card p-4">
              <h2 className="h2 mb-3">Sprzedaż</h2>
              <ul className="space-y-2 text-sm">
                {sales.map((s) => (
                  <li key={s.id}>
                    <b>{s.order_ref}</b> · {dateTime(s.sold_at)}
                    <span className="block text-muted">{SALE_STATUS[s.status]}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {profile.role === "admin" && (
            <form action={deleteUnit} className="text-right">
              <input type="hidden" name="id" value={u.id} />
              <SubmitButton className="btn-danger" pendingText="Usuwam…">Usuń sztukę (pomyłka)</SubmitButton>
            </form>
          )}
        </div>
      </div>
    </>
  );
}

function EventDetails({ data }: { data: Record<string, unknown> }) {
  const parts: string[] = [];
  if (typeof data.order === "string") parts.push(`zamówienie ${data.order}`);
  if (typeof data.from === "string" && typeof data.to === "string" && (UNIT_STATUS[data.from] || UNIT_STATUS[data.to])) {
    parts.push(`${UNIT_STATUS[data.from] ?? data.from} → ${UNIT_STATUS[data.to] ?? data.to}`);
  }
  if (typeof data.replaced_by === "string") parts.push(`zastąpiona sztuką ${data.replaced_by}`);
  if (data.swapped) parts.push("wybrana skanem przy pakowaniu");
  if (typeof data.source === "string") parts.push(data.source);
  if (data.back_to_stock !== undefined) parts.push(data.back_to_stock ? "wraca na stan" : "do sprawdzenia");
  return parts.length ? <span className="text-muted"> · {parts.join(" · ")}</span> : null;
}
