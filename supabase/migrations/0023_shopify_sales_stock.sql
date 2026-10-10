-- 1) Linie sprzedaży także ze Shopify (bez Base): umowa do każdej pozycji zamówienia, przypisanie sztuk na żywo.
-- 2) Zwroty i zwroty pieniędzy ze Shopify przy zamówieniu.
-- 3) Cena w sklepie: opis, dlaczego jej nie ma.
-- 4) Stany: Shopify albo magazyn aplikacji jako główny; lokalizacje Shopify przy lokalizacjach.
-- 5) Faktury: zapisani nabywcy, wysyłka e-mailem.

-- 1) ------------------------------------------------------------------------------------------
alter table public.sales alter column base_order_id drop not null;
alter table public.sales alter column base_order_product_id drop not null;
alter table public.sales add column if not exists shopify_line_id text;
alter table public.sales add column if not exists shopify_line_index int;
create unique index if not exists sales_shopify_line_uq on public.sales (order_id, shopify_line_id, shopify_line_index)
  where shopify_line_id is not null;

-- Od tej chwili zamówienia ze Shopify same tworzą linie sprzedaży i przypisują sztuki (starsze – tylko na żądanie).
insert into public.sync_state (key, value) values ('shopify_sales_since', jsonb_build_object('at', now()))
on conflict (key) do nothing;

/*
 * Blokada na czas transakcji dla jednego zamówienia sklepu (po numerze i ID z Shopify), żeby Base i Shopify
 * nie zapisały równocześnie dwóch linii (i dwóch sprzedanych sztuk) dla tej samej rzeczy.
 */
create or replace function public.lock_order_keys(p_store_id uuid, p_keys text[])
returns void
language plpgsql
as $$
declare
  k text;
begin
  for k in select distinct ltrim(btrim(x), '#') from unnest(p_keys) x where nullif(btrim(coalesce(x, '')), '') is not null order by 1 loop
    perform pg_advisory_xact_lock(hashtext(coalesce(p_store_id::text, '') || ':' || k));
  end loop;
end;
$$;

/*
 * Linia sprzedaży dla jednej sztuki pozycji zamówienia Shopify (np. żeby dołączyć umowę do starego zamówienia).
 * Nie przypisuje sztuki z magazynu – robi to umowa (attach_sale_unit) albo skan.
 */
create or replace function public.ensure_order_line_sale(p_order_id uuid, p_line_id text, p_index int)
returns uuid
language plpgsql
as $$
declare
  o public.orders%rowtype;
  l jsonb;
  v_var uuid;
  v_id uuid;
  v_pieces int;
  v_have int;
begin
  select * into o from public.orders where id = p_order_id;
  if not found then raise exception 'Nie ma takiego zamówienia'; end if;
  perform public.lock_order_keys(o.store_id, array[o.number, o.shopify_legacy_id]);
  if o.cancelled_at is not null then raise exception 'Zamówienie jest anulowane – nie ma sprzedanego przedmiotu'; end if;
  select e into l from jsonb_array_elements(o.line_items) e where e ->> 'id' = p_line_id limit 1;
  if l is null then raise exception 'Nie ma takiej pozycji w zamówieniu'; end if;
  if p_index < 0 or p_index >= greatest(coalesce((l ->> 'quantity')::int, 1), 1) then raise exception 'Zła sztuka pozycji'; end if;
  -- Zwrócone sztuki pozycji (liczone od końca) nie są sprzedane.
  if p_index >= greatest(coalesce((l ->> 'quantity')::int, 1), 1) - coalesce((o.refunded_lines ->> p_line_id)::int, 0) then
    raise exception 'Ta sztuka została zwrócona – nie ma sprzedanego przedmiotu';
  end if;

  select id into v_id from public.sales where order_id = p_order_id and shopify_line_id = p_line_id and shopify_line_index = p_index;
  if found then return v_id; end if;

  if nullif(l ->> 'shopify_variant_id', '') is not null then
    select variant_id into v_var from public.variant_store_links
     where shopify_variant_id = l ->> 'shopify_variant_id'
     order by (store_id = o.store_id) desc limit 1;
  end if;
  -- Wszystkie sztuki zamówienia mają już linie (np. z Base pod innym rozmiarem) → nie dublujemy.
  select coalesce(sum(greatest(coalesce((e ->> 'quantity')::int, 1), 1)), 0) into v_pieces
    from jsonb_array_elements(o.line_items) e where coalesce((e ->> 'service')::boolean, false) = false;
  select count(*) into v_have from public.sales where order_id = p_order_id;
  if v_have >= v_pieces then raise exception 'Wszystkie przedmioty tego zamówienia mają już linie sprzedaży – odśwież stronę'; end if;
  if v_var is not null then
    -- Linie z Base dla tego rozmiaru już pokrywają wszystkie sztuki → nie dublujemy.
    select coalesce(sum(greatest(coalesce((e ->> 'quantity')::int, 1), 1)), 0) into v_pieces
      from jsonb_array_elements(o.line_items) e
     where e ->> 'shopify_variant_id' = l ->> 'shopify_variant_id' and coalesce((e ->> 'service')::boolean, false) = false;
    select count(*) into v_have from public.sales where order_id = p_order_id and variant_id = v_var;
    if v_have >= v_pieces then raise exception 'Ta pozycja ma już linię sprzedaży – odśwież stronę'; end if;
  end if;

  insert into public.sales (store_id, base_order_id, order_id, shopify_line_id, shopify_line_index, line_index, variant_id,
                            order_ref, product_name, status, sold_at, price)
  values (o.store_id, o.base_order_id, p_order_id, p_line_id, p_index, p_index, v_var,
          o.name, concat_ws(' ', l ->> 'title', l ->> 'variant_title'),
          case when v_var is null then 'unmatched' else 'no_unit' end, o.ordered_at, nullif(l ->> 'price', '')::numeric)
  returning id into v_id;
  return v_id;
end;
$$;
grant execute on function public.ensure_order_line_sale(uuid, text, int) to authenticated;

/*
 * Umowa do sprzedanego przedmiotu bez sztuki: tworzy sprzedaną sztukę z tą umową.
 * Gdy produkt nie był powiązany z katalogiem, można wskazać rozmiar z katalogu (p_variant_id).
 */
drop function if exists public.attach_sale_unit(uuid, uuid, numeric);
create or replace function public.attach_sale_unit(p_sale_id uuid, p_contract_id uuid, p_purchase_price numeric default null, p_variant_id uuid default null)
returns uuid
language plpgsql
as $$
declare
  s record;
  v_location uuid;
  v_unit uuid;
begin
  select * into s from public.sales where id = p_sale_id for update;
  if not found then raise exception 'Nie ma takiej sprzedaży'; end if;
  if s.unit_id is not null then raise exception 'Ten przedmiot ma już sztukę z magazynu – dołącz umowę do niej'; end if;
  if s.status = 'cancelled' then raise exception 'Sprzedaż jest anulowana'; end if;
  if s.variant_id is null and p_variant_id is not null then
    update public.sales set variant_id = p_variant_id, status = 'no_unit' where id = p_sale_id;
    s.variant_id := p_variant_id;
  end if;
  if s.variant_id is null then raise exception 'Wybierz produkt i rozmiar z katalogu (pozycja nie jest powiązana z katalogiem)'; end if;

  select id into v_location from public.locations
   where active and (s.store_id is null or store_id = s.store_id)
   order by created_at limit 1;
  if v_location is null then raise exception 'Brak lokalizacji magazynu dla tego sklepu'; end if;

  insert into public.units (variant_id, location_id, status, owner_type, purchase_price, contract_id, sold_at, received_at)
  values (s.variant_id, v_location, 'sold', 'own', p_purchase_price, p_contract_id, s.sold_at, s.sold_at)
  returning id into v_unit;

  update public.sales set unit_id = v_unit, status = 'assigned' where id = p_sale_id;
  insert into public.unit_events (unit_id, type, data)
  values (v_unit, 'contract', jsonb_build_object('contract_id', p_contract_id, 'sale_id', p_sale_id, 'note', 'umowa dołączona do sprzedanego przedmiotu'));
  return v_unit;
end;
$$;
grant execute on function public.attach_sale_unit(uuid, uuid, numeric, uuid) to authenticated;

-- Zapis linii z Base: linię utworzoną już ze Shopify (to samo zamówienie i rozmiar) przejmujemy zamiast dublować.
create or replace function public.register_sale(
  p_store_id uuid,
  p_base_order_id bigint,
  p_base_order_product_id bigint,
  p_variant_id uuid,
  p_quantity int,
  p_order_ref text,
  p_product_name text,
  p_sold_at timestamptz default now()
)
returns int
language plpgsql
as $$
declare
  i int;
  v_unit uuid;
  v_sale uuid;
  v_new int := 0;
begin
  perform public.lock_order_keys(p_store_id, array[p_order_ref]);
  for i in 0..greatest(coalesce(p_quantity, 1), 1) - 1 loop
    if exists (
      select 1 from public.sales
      where base_order_id = p_base_order_id
        and base_order_product_id = p_base_order_product_id
        and line_index = i
    ) then
      continue;
    end if;

    if p_variant_id is not null then
      v_sale := null;
      select s.id into v_sale
        from public.sales s
        join public.orders o on o.id = s.order_id
       where s.base_order_product_id is null
         and s.shopify_line_id is not null
         and s.variant_id = p_variant_id
         and (p_store_id is null or o.store_id = p_store_id)
         and btrim(coalesce(p_order_ref, '')) in (o.number, o.name, o.shopify_legacy_id)
       order by s.shopify_line_index
       limit 1
       for update of s;
      if v_sale is not null then
        update public.sales
           set base_order_id = p_base_order_id, base_order_product_id = p_base_order_product_id, line_index = i
         where id = v_sale;
        continue;
      end if;
    end if;

    v_unit := null;
    if p_variant_id is not null then
      v_unit := public.pick_unit_for_sale(p_variant_id, p_store_id);
    end if;

    insert into public.sales (
      store_id, base_order_id, base_order_product_id, line_index, variant_id, unit_id,
      order_ref, product_name, status, sold_at
    ) values (
      p_store_id, p_base_order_id, p_base_order_product_id, i, p_variant_id, v_unit,
      p_order_ref, p_product_name,
      case when p_variant_id is null then 'unmatched' when v_unit is null then 'no_unit' else 'assigned' end,
      p_sold_at
    ) returning id into v_sale;

    if v_unit is not null then
      update public.units set status = 'sold', sold_at = p_sold_at where id = v_unit;
      insert into public.unit_events (unit_id, type, data)
      values (v_unit, 'sold', jsonb_build_object('sale_id', v_sale, 'order', p_order_ref, 'base_order_id', p_base_order_id));
    end if;
    v_new := v_new + 1;
  end loop;
  return v_new;
end;
$$;

/*
 * Linie sprzedaży z zamówień Shopify (od 'shopify_sales_since'): każda sztuka pozycji powiązanej z katalogiem
 * dostaje linię i – jeśli jest na stanie – sztukę z magazynu (FIFO). Linie z Base tego samego zamówienia się liczą.
 */
create or replace function public.register_shopify_sales(p_order_ids uuid[])
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_since timestamptz;
  o record;
  l record;
  i int;
  v_var uuid;
  v_unit uuid;
  v_sale uuid;
  v_pieces int;
  v_have int;
  v_new int := 0;
begin
  select (value ->> 'at')::timestamptz into v_since from public.sync_state where key = 'shopify_sales_since';
  if v_since is null then return 0; end if;
  perform public.link_sales_to_orders();

  for o in select * from public.orders where id = any(p_order_ids) and cancelled_at is null and ordered_at >= v_since order by id loop
    perform public.lock_order_keys(o.store_id, array[o.number, o.shopify_legacy_id]);
    for l in select e as item from jsonb_array_elements(o.line_items) e
              where coalesce((e ->> 'service')::boolean, false) = false and nullif(e ->> 'shopify_variant_id', '') is not null loop
      v_var := null;
      select variant_id into v_var from public.variant_store_links
       where shopify_variant_id = l.item ->> 'shopify_variant_id'
       order by (store_id = o.store_id) desc limit 1;
      continue when v_var is null;

      for i in 0..greatest(coalesce((l.item ->> 'quantity')::int, 1), 1) - 1 loop
        continue when exists (select 1 from public.sales where order_id = o.id and shopify_line_id = l.item ->> 'id' and shopify_line_index = i);
        select coalesce(sum(greatest(coalesce((e ->> 'quantity')::int, 1), 1)), 0) into v_pieces
          from jsonb_array_elements(o.line_items) e
         where e ->> 'shopify_variant_id' = l.item ->> 'shopify_variant_id' and coalesce((e ->> 'service')::boolean, false) = false;
        select count(*) into v_have from public.sales where order_id = o.id and variant_id = v_var;
        continue when v_have >= v_pieces;

        v_unit := public.pick_unit_for_sale(v_var, o.store_id);
        insert into public.sales (store_id, base_order_id, order_id, shopify_line_id, shopify_line_index, line_index, variant_id, unit_id,
                                  order_ref, product_name, status, sold_at, price)
        values (o.store_id, o.base_order_id, o.id, l.item ->> 'id', i, i, v_var, v_unit,
                o.name, concat_ws(' ', l.item ->> 'title', l.item ->> 'variant_title'),
                case when v_unit is null then 'no_unit' else 'assigned' end, o.ordered_at, nullif(l.item ->> 'price', '')::numeric)
        returning id into v_sale;
        if v_unit is not null then
          update public.units set status = 'sold', sold_at = o.ordered_at where id = v_unit;
          insert into public.unit_events (unit_id, type, data)
          values (v_unit, 'sold', jsonb_build_object('sale_id', v_sale, 'order', o.name, 'source', 'shopify'));
        end if;
        v_new := v_new + 1;
      end loop;
    end loop;
  end loop;
  return v_new;
end;
$$;
revoke all on function public.register_shopify_sales(uuid[]) from public, anon, authenticated;

/* Zamówienie anulowane w Shopify (poza aplikacją): sprzedane sztuki wracają na stan, reszta linii – anulowana. */
create or replace function public.release_order_sales(p_order_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  s record;
  n int := 0;
begin
  for s in select sa.id, sa.unit_id, u.status as unit_status
             from public.sales sa left join public.units u on u.id = sa.unit_id
            where sa.order_id = p_order_id and sa.status <> 'cancelled' loop
    if s.unit_id is not null and s.unit_status in ('sold', 'shipped') then
      perform public.return_unit(s.unit_id, true);
    else
      update public.sales set status = 'cancelled' where id = s.id;
    end if;
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke all on function public.release_order_sales(uuid) from public, anon, authenticated;

-- 2) ------------------------------------------------------------------------------------------
alter table public.orders add column if not exists return_status text;          -- Shopify returnStatus (RETURNED, IN_PROGRESS…)
alter table public.orders add column if not exists refunded_amount numeric(12,2); -- zwrócone (zakończone)
alter table public.orders add column if not exists refund_pending numeric(12,2);  -- zwrot w toku (transakcje PENDING)
alter table public.orders add column if not exists refunded_lines jsonb not null default '{}'; -- {id pozycji: ilość}
-- Ponowny odczyt zamówień (ostatnie 45 dni), żeby uzupełnić zwroty.
delete from public.sync_state where key like 'shopify_orders:%';

-- 3) ------------------------------------------------------------------------------------------
create or replace view public.units_list
with (security_invoker = true) as
select
  u.id, u.number, u.code, u.status, u.owner_type, u.purchase_form, u.purchase_price, u.payout_amount, u.identifier, u.shelf,
  u.received_at, u.sold_at, u.contract_id, u.notes, u.variant_id, u.location_id, u.consignor_id,
  v.option, v.ean,
  p.id as product_id, p.title, p.style_sku, p.image_url,
  l.name as location_name, l.store_id,
  s.name as store_name,
  c.name as consignor_name,
  ct.type as contract_type, ct.counterparty as contract_counterparty,
  sp.shop_price,
  coalesce(
    (select vsl.base_sku from public.variant_store_links vsl where vsl.variant_id = u.variant_id and vsl.store_id = l.store_id and vsl.base_sku is not null limit 1),
    (select vsl.base_sku from public.variant_store_links vsl where vsl.variant_id = u.variant_id and vsl.base_sku is not null limit 1)
  ) as base_sku,
  case
    when sp.shop_price is not null then null
    when not exists (select 1 from public.variant_store_links vsl where vsl.variant_id = u.variant_id and vsl.shopify_variant_id is not null)
      then 'Ten rozmiar nie jest powiązany z wariantem w Shopify – produktu nie ma w sklepie albo nie został jeszcze odczytany. Powiąż go w Katalogu.'
    else 'Shopify nie podał ceny tego wariantu – poczekaj na odczyt produktów (co 15 min) albo kliknij „Sprawdź nowe produkty i stany”.'
  end as shop_price_error
from public.units u
join public.variants v on v.id = u.variant_id
join public.products p on p.id = v.product_id
join public.locations l on l.id = u.location_id
join public.stores s on s.id = l.store_id
left join public.consignors c on c.id = u.consignor_id
left join public.contracts ct on ct.id = u.contract_id
left join lateral (
  select coalesce(
    (select vsl.price from public.variant_store_links vsl where vsl.variant_id = u.variant_id and vsl.store_id = l.store_id and vsl.price is not null limit 1),
    (select vsl.price from public.variant_store_links vsl where vsl.variant_id = u.variant_id and vsl.price is not null order by vsl.updated_at desc limit 1)
  ) as shop_price
) sp on true;
grant select on public.units_list to authenticated;

-- Pełny ponowny odczyt produktów ze Shopify (uzupełnia brakujące ceny), porcjami w automacie.
delete from public.sync_state where key like 'shopify_products:%';

-- 4) ------------------------------------------------------------------------------------------
alter table public.locations add column if not exists shopify_location_id text;
insert into public.app_settings (key, value) values ('stock', '{"master": "shopify"}'::jsonb)
on conflict (key) do nothing;

/*
 * Nadwyżki stanu w źródle (Shopify / Base) nad aplikacją, które czekają na potwierdzenie przy kolejnym odczycie –
 * żeby chwilowe opóźnienie (np. sprzedaż w kasie, której Shopify jeszcze nie zna) nie tworzyło sztuk-widm.
 */
create table if not exists public.stock_excess (
  variant_id uuid not null references public.variants (id) on delete cascade,
  location_id uuid not null references public.locations (id) on delete cascade,
  missing int not null,
  source text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (variant_id, location_id)
);
alter table public.stock_excess enable row level security;

/*
 * Stan ze źródła → brakujące sztuki „bez umowy” w Magazynie. Mniej w źródle niż w aplikacji – nic nie usuwa.
 * p_rows: [{variant_id, location_id, qty, count_locations?}] – count_locations: lokalizacje aplikacji liczone razem
 * (kilka lokalizacji → jedna lokalizacja Shopify); nowe sztuki trafiają do location_id.
 * Sztuka powstaje od razu tylko dla zupełnie nowego produktu; w pozostałych przypadkach nadwyżka musi się utrzymać
 * p_confirm_minutes (kolejny odczyt). Rozmiary z ruchem w aplikacji w ostatnich 30 min są pomijane.
 * p_scope: lokalizacje objęte pełnym odczytem (znikające nadwyżki są z nich kasowane).
 */
drop function if exists public.reconcile_stock(jsonb, int, text);
create or replace function public.reconcile_stock(p_rows jsonb, p_limit int default 300, p_source text default 'Base', p_scope uuid[] default null, p_confirm_minutes int default 10)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_created int := 0;
  v_variants int := 0;
  v_waiting int := 0;
  v_fewer int := 0;
begin
  if not exists (select 1 from public.sync_state where key = 'initial_stock_imported') then
    return jsonb_build_object('created', 0, 'note', 'czekam na wgranie stanów początkowych');
  end if;

  drop table if exists tmp_src;
  drop table if exists tmp_missing;
  drop table if exists tmp_create;
  create temporary table tmp_src on commit drop as
  select distinct on (variant_id, location_id) variant_id, location_id, qty, count_locs
  from (
    select (r->>'variant_id')::uuid as variant_id, (r->>'location_id')::uuid as location_id, (r->>'qty')::int as qty,
           coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(r->'count_locations') x), array[(r->>'location_id')::uuid]) as count_locs
    from jsonb_array_elements(p_rows) r
  ) q
  order by variant_id, location_id, qty desc;

  create temporary table tmp_missing on commit drop as
  select b.variant_id, b.location_id, b.qty - coalesce(cnt.n, 0) as missing
  from tmp_src b
  left join lateral (
    select count(*) as n from public.units u
    where u.variant_id = b.variant_id and u.location_id = any(b.count_locs) and u.status in ('in_stock', 'reserved')
  ) cnt on true
  where b.qty > coalesce(cnt.n, 0)
    and not exists (
      select 1 from public.unit_events e join public.units u on u.id = e.unit_id
      where u.variant_id = b.variant_id and e.created_at > now() - interval '30 minutes'
    );

  select count(*) into v_fewer
  from tmp_src b
  where b.qty < (select count(*) from public.units u where u.variant_id = b.variant_id and u.location_id = any(b.count_locs) and u.status = 'in_stock');

  if p_scope is not null then
    delete from public.stock_excess x
    where x.location_id = any(p_scope)
      and not exists (select 1 from tmp_missing m where m.variant_id = x.variant_id and m.location_id = x.location_id);
  end if;
  insert into public.stock_excess (variant_id, location_id, missing, source)
  select variant_id, location_id, missing, p_source from tmp_missing
  on conflict (variant_id, location_id) do update set missing = excluded.missing, source = excluded.source, last_seen_at = now();

  create temporary table tmp_create on commit drop as
  select m.variant_id, m.location_id, m.missing
  from tmp_missing m
  join public.stock_excess x on x.variant_id = m.variant_id and x.location_id = m.location_id
  where not exists (select 1 from public.units u where u.variant_id = m.variant_id)
     or x.first_seen_at <= now() - make_interval(mins => greatest(p_confirm_minutes, 0));

  select count(*) into v_variants from tmp_create;
  select count(*) - v_variants into v_waiting from tmp_missing;
  if (select coalesce(sum(missing), 0) from tmp_create) > p_limit then
    raise exception '% ma o % sztuk więcej niż aplikacja – to za dużo na automat, sprawdź powiązania magazynów',
      p_source, (select sum(missing) from tmp_create);
  end if;

  with ins as (
    insert into public.units (variant_id, location_id, status, owner_type, purchase_form, notes)
    select m.variant_id, m.location_id, 'in_stock', 'own', 'vat_margin', 'automatycznie: nowy stan w ' || p_source
    from tmp_create m cross join generate_series(1, m.missing)
    returning id
  ), ev as (
    insert into public.unit_events (unit_id, type, data)
    select id, 'received', jsonb_build_object('source', 'automatycznie ze stanu w ' || p_source) from ins
    returning 1
  )
  select count(*) into v_created from ev;
  delete from public.stock_excess x using tmp_create c where x.variant_id = c.variant_id and x.location_id = c.location_id;

  return jsonb_build_object('created', v_created, 'variants', v_variants, 'waiting', v_waiting, 'fewer_in_source', v_fewer);
end;
$$;
revoke all on function public.reconcile_stock(jsonb, int, text, uuid[], int) from public, anon, authenticated;

create or replace function public.reconcile_base_stock(p_rows jsonb, p_limit int default 300)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select public.reconcile_stock(p_rows, p_limit, 'Base',
    (select array_agg(distinct (r->>'location_id')::uuid) from jsonb_array_elements(p_rows) r))
$$;
revoke all on function public.reconcile_base_stock(jsonb, int) from public, anon, authenticated;

-- Liczba sztuk na stanie (do wysyłki stanów do Shopify, gdy główny jest magazyn aplikacji).
create or replace function public.stock_counts(p_location_ids uuid[])
returns table (variant_id uuid, location_id uuid, qty int)
language sql
stable
security definer
set search_path = public
as $$
  select u.variant_id, u.location_id, count(*)::int
  from public.units u
  where u.status = 'in_stock' and u.location_id = any(p_location_ids)
  group by 1, 2
$$;
revoke all on function public.stock_counts(uuid[]) from public, anon, authenticated;

-- 5) ------------------------------------------------------------------------------------------
create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  company boolean not null default true,
  nip text,
  address1 text,
  address2 text,
  country text not null default 'PL',
  email text,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists customers_nip_uq on public.customers (nip) where nip is not null and nip <> '';
create index if not exists customers_name_idx on public.customers (lower(name));
alter table public.customers enable row level security;
drop policy if exists customers_staff on public.customers;
create policy customers_staff on public.customers for all to authenticated using (public.is_staff()) with check (public.is_staff());

alter table public.invoices add column if not exists emailed_at timestamptz;
alter table public.invoices add column if not exists emailed_to text;
alter table public.invoices add column if not exists email_error text;
insert into public.app_settings (key, value) values ('invoices', '{"auto_email": true}'::jsonb)
on conflict (key) do nothing;
