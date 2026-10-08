-- Powiązania z katalogiem Base, podpowiedzi i jednorazowy import stanów.
-- Wklej całość w Supabase → SQL Editor → Run (po 0001_init.sql).

alter table public.stores
  add column if not exists base_storage_id text;      -- ID sklepu w Base, np. shop_2445

alter table public.variant_store_links
  add column if not exists base_parent_id bigint,     -- produkt główny w Base, gdy base_product_id to wariant
  add column if not exists suggested_base_product_id bigint,
  add column if not exists suggested_reason text;

-- Kopia katalogu Base: produkty główne i ich warianty jako osobne wiersze.
create table if not exists public.base_products (
  inventory_id bigint not null,
  id bigint not null,
  parent_id bigint not null default 0,
  name text,                                          -- nazwa produktu głównego
  variant_name text,                                  -- nazwa wariantu, np. "39"
  sku text,
  ean text,
  has_variants boolean not null default false,
  links jsonb not null default '{}'::jsonb,           -- {"shop_2445": {"product_id": "...", "variant_id": "..."}}
  stock jsonb not null default '{}'::jsonb,           -- {"bl_123": 2}
  synced_at timestamptz not null default now(),
  primary key (inventory_id, id)
);
create index if not exists base_products_sku_idx on public.base_products (lower(sku));
create index if not exists base_products_ean_idx on public.base_products (ean);
create index if not exists base_products_name_trgm_idx on public.base_products using gin (name gin_trgm_ops);

alter table public.base_products enable row level security;
drop policy if exists base_products_staff on public.base_products;
create policy base_products_staff on public.base_products for select to authenticated using (public.is_staff());

-- Normalizacja rozmiaru do porównań: "EU 39 1/3" → "391/3", "128 GB" → "128gb".
create or replace function public.norm_option(t text)
returns text language sql immutable as $$
  select case when v in ('jedenrozmiar', 'defaulttitle', 'onesize') then '' else v end
  from (select regexp_replace(lower(regexp_replace(coalesce(t, ''), '^\s*(eu|us|uk|rozmiar|size)\s*', '', 'i')), '[\s,]+', '', 'g') as v) x;
$$;

-- Który sklep w Base (shop_XXXX) odpowiada sklepowi Shopify – wykrywane po ID produktów w powiązaniach.
create or replace function public.detect_base_storage(p_store_id uuid)
returns text
language sql
stable
as $$
  select k.key
  from public.stores s
  join public.base_products bp on bp.inventory_id = s.base_inventory_id
  cross join lateral jsonb_each(bp.links) k
  join public.product_store_links psl
    on psl.store_id = s.id
   and split_part(psl.shopify_product_id, '/', 5) = k.value ->> 'product_id'
  where s.id = p_store_id and k.key like 'shop\_%'
  group by k.key
  order by count(*) desc
  limit 1;
$$;

-- Przepisuje powiązania, które Base już ma ze sklepem, i liczy podpowiedzi dla reszty.
-- Ręcznie przypisanych wariantów nie zmienia.
create or replace function public.apply_base_links(p_store_id uuid)
returns jsonb
language plpgsql
as $$
declare
  v_store public.stores%rowtype;
  v_linked int := 0;
  v_suggested int := 0;
  v_missing int := 0;
begin
  select * into v_store from public.stores where id = p_store_id;
  if v_store.base_inventory_id is null then
    raise exception 'Sklep % nie ma ustawionego katalogu Base', v_store.name;
  end if;

  if v_store.base_storage_id is null then
    update public.stores set base_storage_id = public.detect_base_storage(p_store_id)
    where id = p_store_id
    returning * into v_store;
  end if;

  -- 1. Powiązania z Base: wariant Base → wariant Shopify.
  if v_store.base_storage_id is not null then
    with candidates as (
      select distinct on (vsl.id)
        vsl.id as link_id, bp.id as base_id, bp.parent_id, bp.sku
      from public.variant_store_links vsl
      join public.base_products bp
        on bp.inventory_id = v_store.base_inventory_id
       and bp.links ? v_store.base_storage_id
      where vsl.store_id = p_store_id
        and vsl.base_link_source is distinct from 'manual'
        and (
          -- wariant Base wskazuje dokładnie ten wariant Shopify
          (bp.links -> v_store.base_storage_id ->> 'variant_id') = split_part(vsl.shopify_variant_id, '/', 5)
          or (
            -- produkt Base bez wariantów, powiązany z produktem Shopify, który ma jeden wariant
            not bp.has_variants and bp.parent_id = 0
            and coalesce(bp.links -> v_store.base_storage_id ->> 'variant_id', '0') in ('0', '')
            and exists (
              select 1 from public.variants v
              join public.product_store_links psl on psl.product_id = v.product_id and psl.store_id = p_store_id
              where v.id = vsl.variant_id
                and split_part(psl.shopify_product_id, '/', 5) = bp.links -> v_store.base_storage_id ->> 'product_id'
                and (select count(*) from public.variant_store_links x
                     join public.variants xv on xv.id = x.variant_id
                     where x.store_id = p_store_id and xv.product_id = v.product_id) = 1
            )
          )
        )
      order by vsl.id, bp.parent_id desc
    )
    update public.variant_store_links vsl
    set base_product_id = c.base_id,
        base_parent_id = nullif(c.parent_id, 0),
        base_sku = c.sku,
        base_link_source = 'base',
        base_linked_at = now(),
        suggested_base_product_id = null,
        suggested_reason = null
    from candidates c
    where vsl.id = c.link_id;
    get diagnostics v_linked = row_count;
  end if;

  -- 2. Podpowiedzi dla niepowiązanych: najpierw EAN, potem nazwa modelu + rozmiar.
  update public.variant_store_links vsl
  set suggested_base_product_id = null, suggested_reason = null
  where vsl.store_id = p_store_id and vsl.base_product_id is null;

  with unlinked as (
    select vsl.id as link_id, v.ean, v.option, p.title
    from public.variant_store_links vsl
    join public.variants v on v.id = vsl.variant_id
    join public.products p on p.id = v.product_id
    where vsl.store_id = p_store_id and vsl.base_product_id is null
  ),
  by_ean as (
    select distinct on (u.link_id) u.link_id, bp.id as base_id, 'EAN ' || bp.ean as reason
    from unlinked u
    join public.base_products bp on bp.inventory_id = v_store.base_inventory_id
     and coalesce(u.ean, '') <> '' and bp.ean = u.ean and not bp.has_variants
    order by u.link_id, bp.id
  ),
  by_name as (
    select distinct on (u.link_id) u.link_id, bp.id as base_id,
      'nazwa ' || round(similarity(u.title, bp.name)::numeric * 100) || '% + rozmiar' as reason
    from unlinked u
    join public.base_products bp on bp.inventory_id = v_store.base_inventory_id
     and not bp.has_variants
     and public.norm_option(coalesce(bp.variant_name, '')) = public.norm_option(u.option)
     and bp.name % u.title
    where not exists (select 1 from by_ean e where e.link_id = u.link_id)
    order by u.link_id, similarity(u.title, bp.name) desc
  ),
  picks as (
    select * from by_ean union all select * from by_name
  )
  update public.variant_store_links vsl
  set suggested_base_product_id = picks.base_id, suggested_reason = picks.reason
  from picks
  where vsl.id = picks.link_id;
  get diagnostics v_suggested = row_count;

  select count(*) into v_missing from public.variant_store_links
  where store_id = p_store_id and base_product_id is null and suggested_base_product_id is null;

  return jsonb_build_object('linked', v_linked, 'suggested', v_suggested, 'missing', v_missing,
                            'base_storage_id', v_store.base_storage_id);
end;
$$;

-- Ręczne zatwierdzenie podpowiedzi albo przypisanie produktu Base do wariantu.
create or replace function public.set_base_link(p_link_id uuid, p_base_product_id bigint)
returns void
language plpgsql
as $$
declare
  v_inv bigint;
  v_bp public.base_products%rowtype;
begin
  select s.base_inventory_id into v_inv
  from public.variant_store_links vsl join public.stores s on s.id = vsl.store_id
  where vsl.id = p_link_id;

  if p_base_product_id is null then
    update public.variant_store_links
    set base_product_id = null, base_parent_id = null, base_sku = null, base_link_source = null, base_linked_at = null
    where id = p_link_id;
    return;
  end if;

  select * into v_bp from public.base_products where inventory_id = v_inv and id = p_base_product_id;
  if not found then
    raise exception 'Nie ma produktu % w katalogu Base tego sklepu (odśwież katalog Base)', p_base_product_id;
  end if;
  if v_bp.has_variants then
    raise exception 'Produkt % ma warianty – wybierz konkretny rozmiar', p_base_product_id;
  end if;

  update public.variant_store_links
  set base_product_id = v_bp.id,
      base_parent_id = nullif(v_bp.parent_id, 0),
      base_sku = v_bp.sku,
      base_link_source = 'manual',
      base_linked_at = now(),
      suggested_base_product_id = null,
      suggested_reason = null
  where id = p_link_id;
end;
$$;

-- Jednorazowe wgranie obecnych stanów z Base jako sztuk „bez umowy”.
-- Jeden produkt Base w jednym magazynie Base daje sztuki tylko raz, nawet gdy jest w obu sklepach.
create or replace function public.import_initial_stock()
returns jsonb
language plpgsql
as $$
declare
  v_units int := 0;
  v_variants int := 0;
  v_snapshot timestamptz;
begin
  if exists (select 1 from public.sync_state where key = 'initial_stock_imported') then
    raise exception 'Stany z Base zostały już wgrane (%).',
      (select value ->> 'at' from public.sync_state where key = 'initial_stock_imported');
  end if;

  -- Stany muszą być świeże: zamówienia od chwili pobrania katalogu Base będą już odczytywane.
  select min(bp.synced_at) into v_snapshot
  from public.variant_store_links vsl
  join public.stores s on s.id = vsl.store_id
  join public.base_products bp on bp.inventory_id = s.base_inventory_id and bp.id = vsl.base_product_id;
  if v_snapshot is null then
    raise exception 'Brak rozmiarów powiązanych z Base. Najpierw pobierz katalog Base i powiąż produkty (Katalog).';
  end if;
  if v_snapshot < now() - interval '30 minutes' then
    raise exception 'Katalog Base pobrano %. Pobierz go ponownie tuż przed wgraniem stanów.', to_char(v_snapshot at time zone 'Europe/Warsaw', 'DD.MM HH24:MI');
  end if;

  create temporary table tmp_stock on commit drop as
  select distinct on (s.base_inventory_id, vsl.base_product_id, w.key)
    vsl.variant_id,
    l.id as location_id,
    (w.value)::text::numeric::int as qty
  from public.variant_store_links vsl
  join public.stores s on s.id = vsl.store_id
  join public.base_products bp on bp.inventory_id = s.base_inventory_id and bp.id = vsl.base_product_id
  cross join lateral jsonb_each(bp.stock) w
  join public.locations l on l.base_warehouse_id = w.key and l.active
  where vsl.base_product_id is not null
    and jsonb_typeof(w.value) = 'number'
    and (w.value)::text::numeric > 0
  order by s.base_inventory_id, vsl.base_product_id, w.key, (l.store_id = vsl.store_id) desc, l.created_at;

  with ins as (
    insert into public.units (variant_id, location_id, status, owner_type, purchase_form, notes)
    select t.variant_id, t.location_id, 'in_stock', 'own', 'vat_margin', 'import stanów z Base'
    from tmp_stock t
    cross join generate_series(1, t.qty)
    returning id
  ), ev as (
    insert into public.unit_events (unit_id, type, data)
    select id, 'received', '{"source": "import z Base"}'::jsonb from ins
    returning 1
  )
  select count(*) into v_units from ev;

  select count(*) into v_variants from tmp_stock;

  insert into public.sync_state (key, value)
  values ('initial_stock_imported', jsonb_build_object('at', now(), 'units', v_units, 'variants', v_variants, 'snapshot', v_snapshot));

  -- Sprzedaż liczymy od chwili, z której pochodzą stany (zamówienia po niej zdejmą sztuki).
  insert into public.sync_state (key, value)
  values ('base_orders', jsonb_build_object('from', floor(extract(epoch from v_snapshot))::bigint))
  on conflict (key) do update set value = excluded.value, updated_at = now();

  return jsonb_build_object('units', v_units, 'variants', v_variants);
end;
$$;

-- Podgląd importu przed uruchomieniem.
create or replace function public.preview_initial_stock()
returns jsonb
language sql
stable
as $$
  with s as (
    select distinct on (st.base_inventory_id, vsl.base_product_id, w.key)
      (w.value)::text::numeric::int as qty
    from public.variant_store_links vsl
    join public.stores st on st.id = vsl.store_id
    join public.base_products bp on bp.inventory_id = st.base_inventory_id and bp.id = vsl.base_product_id
    cross join lateral jsonb_each(bp.stock) w
    join public.locations l on l.base_warehouse_id = w.key and l.active
    where vsl.base_product_id is not null and jsonb_typeof(w.value) = 'number' and (w.value)::text::numeric > 0
    order by st.base_inventory_id, vsl.base_product_id, w.key
  )
  select jsonb_build_object('units', coalesce(sum(qty), 0), 'variants', count(*)) from s;
$$;

-- Zadania w tle zapisują stan synchronizacji (tylko klucz service_role omija RLS).
drop policy if exists sync_state_admin on public.sync_state;
create policy sync_state_admin on public.sync_state for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists sync_log_staff_insert on public.sync_log;
create policy sync_log_staff_insert on public.sync_log for insert to authenticated with check (public.is_staff());

-- Dostawa z kilkoma rozmiarami: kolejne linie dopisują się do tej samej dostawy.
drop function if exists public.receive_delivery(uuid, uuid, uuid, int, text, text, uuid, text, numeric, numeric, uuid, text[], text, text);

create or replace function public.receive_delivery(
  p_store_id uuid,
  p_location_id uuid,
  p_variant_id uuid,
  p_quantity int,
  p_status text default 'in_stock',
  p_owner_type text default 'own',
  p_consignor_id uuid default null,
  p_purchase_form text default 'vat_margin',
  p_purchase_price numeric default null,
  p_payout_amount numeric default null,
  p_contract_id uuid default null,
  p_identifiers text[] default '{}',
  p_shelf text default null,
  p_note text default null,
  p_delivery_id uuid default null
)
returns uuid
language plpgsql
as $$
declare
  v_delivery uuid := p_delivery_id;
  v_unit uuid;
  i int;
begin
  if p_quantity is null or p_quantity < 1 or p_quantity > 500 then
    raise exception 'Liczba sztuk musi być od 1 do 500';
  end if;
  if p_status not in ('in_stock', 'in_transit') then
    raise exception 'Nowa sztuka może być tylko na stanie albo w drodze';
  end if;
  if not exists (select 1 from public.locations where id = p_location_id and store_id = p_store_id) then
    raise exception 'Lokalizacja nie należy do wybranego sklepu';
  end if;
  if p_owner_type = 'consignment' and p_consignor_id is null then
    raise exception 'Dla komisu wybierz komisanta';
  end if;

  if v_delivery is null then
    insert into public.deliveries (store_id, location_id, note)
    values (p_store_id, p_location_id, p_note)
    returning id into v_delivery;
  elsif not exists (select 1 from public.deliveries where id = v_delivery and location_id = p_location_id) then
    raise exception 'Dostawa % nie istnieje albo ma inną lokalizację', v_delivery;
  end if;

  for i in 1..p_quantity loop
    insert into public.units (
      variant_id, location_id, delivery_id, status, owner_type, consignor_id,
      purchase_form, purchase_price, payout_amount, identifier, shelf, contract_id
    ) values (
      p_variant_id, p_location_id, v_delivery, p_status, p_owner_type,
      case when p_owner_type = 'consignment' then p_consignor_id end,
      case when p_owner_type = 'consignment' then 'consignment' else p_purchase_form end,
      p_purchase_price, p_payout_amount,
      nullif(upper(trim(coalesce(p_identifiers[i], ''))), ''),
      p_shelf, p_contract_id
    ) returning id into v_unit;

    insert into public.unit_events (unit_id, type, data)
    values (v_unit, 'received', jsonb_build_object('delivery_id', v_delivery, 'status', p_status));
  end loop;

  return v_delivery;
end;
$$;

-- Zmiany stanu w Base, których nie udało się wysłać (do ponowienia z ekranu dostawy).
alter table public.deliveries add column if not exists base_pending jsonb not null default '[]'::jsonb;


-- ───────── Poprawki po przeglądzie ─────────

-- Zamiana sztuki przy pakowaniu: nie dla anulowanych sprzedaży; poprzednia sztuka wraca na stan
-- tylko wtedy, gdy nadal jest sprzedana i nie należy do innej aktywnej sprzedaży.
create or replace function public.swap_sale_unit(p_sale_id uuid, p_code text)
returns uuid
language plpgsql
as $$
declare
  v_sale public.sales%rowtype;
  v_new public.units%rowtype;
  v_code text := upper(trim(p_code));
begin
  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found then
    raise exception 'Nie ma takiej sprzedaży';
  end if;
  if v_sale.status in ('cancelled', 'unmatched') then
    raise exception 'Ta sprzedaż jest anulowana albo bez powiązanego produktu – nie można zmienić sztuki';
  end if;

  select * into v_new from public.units
  where code = v_code or upper(identifier) = v_code
  order by (status = 'in_stock') desc
  limit 1
  for update;
  if not found then
    raise exception 'Nie znaleziono sztuki o kodzie %', p_code;
  end if;
  if v_sale.variant_id is not null and v_new.variant_id <> v_sale.variant_id then
    raise exception 'Sztuka % to inny produkt lub rozmiar niż w zamówieniu', v_new.code;
  end if;
  if v_new.id = v_sale.unit_id then
    return v_new.id;
  end if;
  if v_new.status <> 'in_stock' then
    raise exception 'Sztuka % nie jest na stanie', v_new.code;
  end if;

  if v_sale.unit_id is not null then
    update public.units u set status = 'in_stock', sold_at = null
    where u.id = v_sale.unit_id
      and u.status = 'sold'
      and not exists (
        select 1 from public.sales s
        where s.unit_id = v_sale.unit_id and s.status = 'assigned' and s.id <> p_sale_id
      );
    if found then
      insert into public.unit_events (unit_id, type, data)
      values (v_sale.unit_id, 'swapped', jsonb_build_object('sale_id', p_sale_id, 'replaced_by', v_new.code));
    end if;
  end if;

  update public.units set status = 'sold', sold_at = v_sale.sold_at where id = v_new.id;
  insert into public.unit_events (unit_id, type, data)
  values (v_new.id, 'sold', jsonb_build_object('sale_id', p_sale_id, 'order', v_sale.order_ref, 'swapped', true));

  update public.sales
  set unit_id = v_new.id, variant_id = v_new.variant_id, status = 'assigned'
  where id = p_sale_id;

  return v_new.id;
end;
$$;

-- Nowe konta są nieaktywne, dopóki administrator ich nie włączy (pierwsze konto = administrator).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  first_user boolean;
begin
  select not exists (select 1 from public.profiles) into first_user;
  insert into public.profiles (id, email, role, can_see_prices, active)
  values (new.id, new.email, case when first_user then 'admin' else 'staff' end, first_user, first_user);
  return new;
end;
$$;

-- Usuwanie rekordów magazynu tylko przez administratora.
do $$
declare t text;
begin
  foreach t in array array['units', 'contracts', 'sales', 'unit_events', 'deliveries', 'consignors', 'products', 'variants', 'variant_store_links', 'product_store_links'] loop
    execute format('drop policy if exists %I on public.%I', t || '_staff', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_staff())', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.is_staff())', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.is_staff()) with check (public.is_staff())', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.is_admin())', t || '_delete', t);
  end loop;
end $$;

-- IMEI i numery seryjne zapisujemy wielkimi literami (wyszukiwanie i skan bez rozróżniania wielkości).
update public.units set identifier = upper(identifier) where identifier <> upper(identifier);

-- Liczniki bez limitu 1000 wierszy API.
create or replace view public.variant_stock_totals with (security_invoker = true) as
select variant_id, count(*) filter (where status = 'in_stock') as in_stock
from public.units
group by variant_id;

create or replace view public.consignor_stats with (security_invoker = true) as
select
  consignor_id,
  count(*) filter (where status in ('in_stock', 'in_transit', 'reserved')) as on_stock,
  count(*) filter (where status in ('sold', 'shipped')) as sold,
  coalesce(sum(payout_amount) filter (where status in ('sold', 'shipped')), 0) as payout_sold
from public.units
where owner_type = 'consignment'
group by consignor_id;

-- Pliki umów: do 25 MB, tylko PDF i zdjęcia.
update storage.buckets
set file_size_limit = 26214400,
    allowed_mime_types = array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
where id = 'contracts';
