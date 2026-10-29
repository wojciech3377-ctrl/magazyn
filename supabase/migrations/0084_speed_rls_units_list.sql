-- 0084: Szybsza baza (wolny Magazyn i listy).
-- 1) Zasady dostępu (RLS) sprawdzały is_staff() / is_admin() / auth.uid() OSOBNO DLA KAŻDEGO WIERSZA każdej tabeli
--    (lista sztuk = kilka tabel × tysiące wierszy = dziesiątki tysięcy sprawdzeń na jedno otwarcie strony).
--    Teraz raz na zapytanie: (select public.is_staff()) – zalecany przez Supabase zapis, te same uprawnienia.
-- 2) Lista sztuk (units_list): cena ze sklepu liczona tylko dla wierszy, które faktycznie są pokazywane
--    (wcześniej także przy liczeniu „ile wszystkich” – dla każdej sztuki w magazynie).
-- 3) Indeks pod domyślne sortowanie listy (data przyjęcia, najnowsze najpierw) – strona bez sortowania całej tabeli.
-- Można uruchomić kilka razy.

-- ───────── 1. RLS: funkcje uprawnień raz na zapytanie ─────────
do $$
declare
  p record;
  q text;
  c text;
  stmt text;
  n int := 0;
  re_fn constant text := '(^|[^A-Za-z0-9_.])(public\.)?(is_staff|is_admin)\(\)';
  re_uid constant text := '(^|[^A-Za-z0-9_.])auth\.uid\(\)';
  done_re constant text := 'SELECT (public\.)?(is_staff|is_admin)\(\)|SELECT auth\.uid\(\)';
begin
  for p in
    select schemaname, tablename, policyname, cmd, qual, with_check
      from pg_policies
     where schemaname = 'public'
       and (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~ '(is_staff|is_admin|auth\.uid)\(\)'
  loop
    -- Już przerobione (ponowne uruchomienie) – pomijamy.
    if (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~ done_re then continue; end if;
    q := p.qual;
    c := p.with_check;
    if q is not null then
      q := regexp_replace(q, re_fn, '\1(select public.\3())', 'g');
      q := regexp_replace(q, re_uid, '\1(select auth.uid())', 'g');
    end if;
    if c is not null then
      c := regexp_replace(c, re_fn, '\1(select public.\3())', 'g');
      c := regexp_replace(c, re_uid, '\1(select auth.uid())', 'g');
    end if;
    stmt := format('alter policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
    if q is not null then stmt := stmt || format(' using (%s)', q); end if;
    if c is not null then stmt := stmt || format(' with check (%s)', c); end if;
    execute stmt;
    n := n + 1;
  end loop;
  raise notice 'Przyspieszone zasady dostępu: %', n;
end $$;

-- ───────── 2. Lista sztuk: cena ze sklepu tylko dla pokazywanych wierszy ─────────
-- Te same kolumny w tej samej kolejności (zależne funkcje unassigned() / collections() zostają).
create or replace view public.units_list
with (security_invoker = true) as
select x.id, x.number, x.code, x.status, x.owner_type, x.purchase_form, x.purchase_price, x.payout_amount, x.identifier, x.shelf,
  x.received_at, x.sold_at, x.contract_id, x.notes, x.variant_id, x.location_id, x.consignor_id,
  x.option, x.ean,
  x.product_id, x.title, x.style_sku, x.image_url,
  x.location_name, x.store_id,
  x.store_name,
  x.consignor_name,
  x.contract_type, x.contract_counterparty,
  x.shop_price,
  coalesce(
    (select vsl.base_sku from public.variant_store_links vsl where vsl.variant_id = x.variant_id and vsl.store_id = x.store_id and vsl.base_sku is not null limit 1),
    (select vsl.base_sku from public.variant_store_links vsl where vsl.variant_id = x.variant_id and vsl.base_sku is not null limit 1)
  ) as base_sku,
  case
    when x.shop_price is not null then null
    when not exists (select 1 from public.variant_store_links vsl where vsl.variant_id = x.variant_id and vsl.shopify_variant_id is not null)
      then 'Ten rozmiar nie jest powiązany z wariantem w Shopify – produktu nie ma w sklepie albo nie został jeszcze odczytany. Powiąż go w Katalogu.'
    else 'Shopify nie podał ceny tego wariantu – poczekaj na odczyt produktów (co 15 min) albo kliknij „Sprawdź nowe produkty i stany”.'
  end as shop_price_error,
  not exists (select 1 from public.variant_store_links vsl where vsl.variant_id = x.variant_id and vsl.shopify_variant_id is not null) as shop_missing
from (
  select
    u.id, u.number, u.code, u.status, u.owner_type, u.purchase_form, u.purchase_price, u.payout_amount, u.identifier, u.shelf,
    u.received_at, u.sold_at, u.contract_id, u.notes, u.variant_id, u.location_id, u.consignor_id,
    v.option, v.ean,
    p.id as product_id, p.title, p.style_sku, p.image_url,
    l.name as location_name, l.store_id,
    s.name as store_name,
    c.name as consignor_name,
    ct.type as contract_type, ct.counterparty as contract_counterparty,
    coalesce(
      (select vsl.price from public.variant_store_links vsl where vsl.variant_id = u.variant_id and vsl.store_id = l.store_id and vsl.price is not null limit 1),
      (select vsl.price from public.variant_store_links vsl where vsl.variant_id = u.variant_id and vsl.price is not null order by vsl.updated_at desc limit 1)
    ) as shop_price
  from public.units u
  join public.variants v on v.id = u.variant_id
  join public.products p on p.id = v.product_id
  join public.locations l on l.id = u.location_id
  join public.stores s on s.id = l.store_id
  left join public.consignors c on c.id = u.consignor_id
  left join public.contracts ct on ct.id = u.contract_id
) x;
grant select on public.units_list to authenticated;

-- ───────── 3. Indeksy ─────────
-- Domyślne sortowanie listy sztuk: przyjęte najnowsze najpierw (puste daty na końcu), potem numer.
create index if not exists units_received_number_idx on public.units (received_at desc nulls last, number desc);
-- Cena / SKU ze sklepu dla rozmiaru w danym sklepie.
create index if not exists variant_store_links_variant_store_idx on public.variant_store_links (variant_id, store_id);

analyze public.units;
analyze public.variant_store_links;

notify pgrst, 'reload schema';
