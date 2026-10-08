-- Magazyn sztuk z umowami – etap 1
-- Wklej całość w Supabase → SQL Editor → Run (jednorazowo, na pustym projekcie).

create extension if not exists pg_trgm;

-- ───────────────────────── Użytkownicy ─────────────────────────

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  full_name text,
  role text not null default 'staff' check (role in ('admin', 'staff')),
  can_see_prices boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Pierwsze konto zostaje administratorem, kolejne pracownikami.
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
  insert into public.profiles (id, email, role, can_see_prices)
  values (new.id, new.email, case when first_user then 'admin' else 'staff' end, first_user);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active);
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active and role = 'admin');
$$;

-- ───────────────────────── Sklepy i lokalizacje ─────────────────────────

create table public.stores (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,                 -- np. telefoniki, sneakers-depot
  name text not null,
  shopify_domain text,                       -- np. telefoniki.myshopify.com
  base_inventory_id bigint,                  -- katalog w Base, z którego korzysta sklep
  base_order_source_id bigint,               -- ID źródła zamówień tego sklepu w Base
  created_at timestamptz not null default now()
);

create table public.locations (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id),
  name text not null,
  base_warehouse_id text,                    -- np. bl_12345
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (store_id, name)
);

-- ───────────────────────── Katalog ─────────────────────────

create table public.products (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  style_sku text,                            -- SKU modelu ze Shopify (wspólne dla rozmiarów)
  vendor text,
  product_type text,
  image_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index products_style_sku_idx on public.products (lower(style_sku));
create index products_title_trgm_idx on public.products using gin (title gin_trgm_ops);

create table public.product_store_links (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  store_id uuid not null references public.stores (id),
  shopify_product_id text not null,          -- gid://shopify/Product/...
  handle text,
  status text,
  updated_at timestamptz not null default now(),
  unique (store_id, shopify_product_id)
);

create table public.variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  option text not null,                      -- rozmiar albo pamięć, np. "39" lub "128 GB / Czarny"
  ean text,
  position int not null default 0,
  created_at timestamptz not null default now(),
  unique (product_id, option)
);

-- Wariant w konkretnym sklepie + jego odpowiednik w Base.
create table public.variant_store_links (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references public.variants (id) on delete cascade,
  store_id uuid not null references public.stores (id),
  shopify_variant_id text not null,          -- gid://shopify/ProductVariant/...
  shopify_inventory_item_id text,
  sku text,
  base_product_id bigint,                    -- ID produktu lub wariantu w katalogu Base
  base_sku text,
  base_link_source text check (base_link_source in ('base', 'suggested', 'manual')),
  base_linked_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (store_id, shopify_variant_id)
);
create index variant_store_links_variant_idx on public.variant_store_links (variant_id);
create index variant_store_links_base_idx on public.variant_store_links (base_product_id);

-- ───────────────────────── Komisanci i umowy ─────────────────────────

create table public.consignors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text,
  phone text,
  bank_account text,
  notes text,
  created_at timestamptz not null default now()
);

create table public.contracts (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('purchase', 'consignment', 'invoice', 'other')),
  counterparty text not null,                -- osoba lub firma z umowy
  consignor_id uuid references public.consignors (id),
  contract_date date,
  amount numeric(12, 2),
  file_path text,                            -- ścieżka w Storage (bucket contracts)
  file_name text,
  notes text,
  created_by uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now()
);

-- ───────────────────────── Dostawy i sztuki ─────────────────────────

create table public.deliveries (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id),
  location_id uuid not null references public.locations (id),
  note text,
  base_sync_status text not null default 'pending' check (base_sync_status in ('pending', 'ok', 'error', 'skipped')),
  base_sync_error text,
  created_by uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now()
);

create sequence public.unit_number_seq start 1;

create table public.units (
  id uuid primary key default gen_random_uuid(),
  number bigint not null unique default nextval('public.unit_number_seq'),
  code text generated always as ('S' || lpad(number::text, 6, '0')) stored,
  variant_id uuid not null references public.variants (id),
  location_id uuid not null references public.locations (id),
  delivery_id uuid references public.deliveries (id),
  status text not null default 'in_stock'
    check (status in ('in_transit', 'in_stock', 'reserved', 'sold', 'shipped', 'returned')),
  owner_type text not null default 'own' check (owner_type in ('own', 'consignment')),
  consignor_id uuid references public.consignors (id),
  purchase_form text not null default 'vat_margin'
    check (purchase_form in ('vat_margin', 'invoice', 'receipt_0', 'consignment')),
  purchase_price numeric(12, 2),
  payout_amount numeric(12, 2),              -- komis: stała kwota dla komisanta
  identifier text,                           -- IMEI lub numer seryjny
  shelf text,                                -- regał / półka
  contract_id uuid references public.contracts (id) on delete set null,
  notes text,
  received_at timestamptz not null default now(),
  sold_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint consignment_has_consignor check (owner_type = 'own' or consignor_id is not null)
);
create index units_variant_status_idx on public.units (variant_id, status);
create index units_location_idx on public.units (location_id);
create index units_contract_idx on public.units (contract_id);
create index units_identifier_idx on public.units (identifier);
alter sequence public.unit_number_seq owned by public.units.number;

create table public.unit_events (
  id bigint generated always as identity primary key,
  unit_id uuid not null references public.units (id) on delete cascade,
  type text not null,                        -- received, moved, status, sold, swapped, contract, edited
  data jsonb not null default '{}'::jsonb,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index unit_events_unit_idx on public.unit_events (unit_id, created_at);

-- ───────────────────────── Sprzedaż z Base ─────────────────────────

create table public.sales (
  id uuid primary key default gen_random_uuid(),
  store_id uuid references public.stores (id),
  base_order_id bigint not null,
  base_order_product_id bigint not null,
  line_index int not null default 0,         -- kolejna sztuka przy ilości > 1
  variant_id uuid references public.variants (id),
  unit_id uuid references public.units (id),
  order_ref text,                            -- numer zamówienia ze sklepu
  product_name text,
  status text not null default 'assigned' check (status in ('assigned', 'no_unit', 'unmatched', 'cancelled')),
  sold_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (base_order_id, base_order_product_id, line_index)
);
create index sales_status_idx on public.sales (status);

create table public.sync_state (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table public.sync_log (
  id bigint generated always as identity primary key,
  job text not null,
  ok boolean not null,
  message text,
  created_at timestamptz not null default now()
);

-- ───────────────────────── updated_at ─────────────────────────

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger units_touch before update on public.units
  for each row execute function public.touch_updated_at();
create trigger products_touch before update on public.products
  for each row execute function public.touch_updated_at();

-- ───────────────────────── Logika magazynu ─────────────────────────

-- Przyjęcie dostawy: tworzy N sztuk jednego wariantu w jednej transakcji.
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
  p_note text default null
)
returns uuid
language plpgsql
as $$
declare
  v_delivery uuid;
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

  insert into public.deliveries (store_id, location_id, note)
  values (p_store_id, p_location_id, p_note)
  returning id into v_delivery;

  for i in 1..p_quantity loop
    insert into public.units (
      variant_id, location_id, delivery_id, status, owner_type, consignor_id,
      purchase_form, purchase_price, payout_amount, identifier, shelf, contract_id
    ) values (
      p_variant_id, p_location_id, v_delivery, p_status, p_owner_type,
      case when p_owner_type = 'consignment' then p_consignor_id end,
      case when p_owner_type = 'consignment' then 'consignment' else p_purchase_form end,
      p_purchase_price, p_payout_amount,
      nullif(trim(coalesce(p_identifiers[i], '')), ''),
      p_shelf, p_contract_id
    ) returning id into v_unit;

    insert into public.unit_events (unit_id, type, data)
    values (v_unit, 'received', jsonb_build_object('delivery_id', v_delivery, 'status', p_status));
  end loop;

  return v_delivery;
end;
$$;

-- Wybór sztuki do sprzedaży: najpierw własne, potem komis; w obu grupach od najstarszej.
-- Sztuki z lokalizacji sklepu, z którego przyszło zamówienie, mają pierwszeństwo.
create or replace function public.pick_unit_for_sale(p_variant_id uuid, p_store_id uuid default null)
returns uuid
language sql
as $$
  select u.id
  from public.units u
  join public.locations l on l.id = u.location_id
  where u.variant_id = p_variant_id
    and u.status = 'in_stock'
  order by
    (p_store_id is not null and l.store_id = p_store_id) desc,
    (u.owner_type = 'consignment') asc,
    u.received_at asc,
    u.number asc
  limit 1
  for update of u skip locked;
$$;

-- Zapis jednej linii zamówienia z Base. Bezpieczny przy ponownym uruchomieniu.
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
  for i in 0..greatest(coalesce(p_quantity, 1), 1) - 1 loop
    if exists (
      select 1 from public.sales
      where base_order_id = p_base_order_id
        and base_order_product_id = p_base_order_product_id
        and line_index = i
    ) then
      continue;
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

-- Zmiana sztuki przy pakowaniu: skan kodu sztuki (S000123), IMEI lub numeru seryjnego.
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
    update public.units set status = 'in_stock', sold_at = null where id = v_sale.unit_id;
    insert into public.unit_events (unit_id, type, data)
    values (v_sale.unit_id, 'swapped', jsonb_build_object('sale_id', p_sale_id, 'replaced_by', v_new.code));
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

-- Zwrot sprzedanej sztuki: zamyka jej sprzedaż i wraca na stan albo zostaje jako „zwrot”.
create or replace function public.return_unit(p_unit_id uuid, p_back_to_stock boolean)
returns void
language plpgsql
as $$
declare
  v_status text;
begin
  select status into v_status from public.units where id = p_unit_id for update;
  if not found then
    raise exception 'Nie ma takiej sztuki';
  end if;
  if v_status not in ('sold', 'shipped', 'returned') then
    raise exception 'Zwrot dotyczy tylko sztuk sprzedanych lub wydanych';
  end if;

  update public.sales set status = 'cancelled'
  where unit_id = p_unit_id and status = 'assigned';

  update public.units
  set status = case when p_back_to_stock then 'in_stock' else 'returned' end,
      sold_at = null
  where id = p_unit_id;

  insert into public.unit_events (unit_id, type, data)
  values (p_unit_id, 'returned', jsonb_build_object('back_to_stock', p_back_to_stock, 'from', v_status));
end;
$$;

-- Liczba sztuk na stanie dla wariantu w danym magazynie Base (do kontroli zgodności).
create or replace view public.variant_stock with (security_invoker = true) as
select
  u.variant_id,
  l.store_id,
  u.location_id,
  count(*) filter (where u.status = 'in_stock') as in_stock,
  count(*) filter (where u.status = 'in_transit') as in_transit,
  count(*) filter (where u.status = 'reserved') as reserved
from public.units u
join public.locations l on l.id = u.location_id
group by u.variant_id, l.store_id, u.location_id;

-- ───────────────────────── Uprawnienia (RLS) ─────────────────────────

alter table public.profiles enable row level security;
alter table public.stores enable row level security;
alter table public.locations enable row level security;
alter table public.products enable row level security;
alter table public.product_store_links enable row level security;
alter table public.variants enable row level security;
alter table public.variant_store_links enable row level security;
alter table public.consignors enable row level security;
alter table public.contracts enable row level security;
alter table public.deliveries enable row level security;
alter table public.units enable row level security;
alter table public.unit_events enable row level security;
alter table public.sales enable row level security;
alter table public.sync_state enable row level security;
alter table public.sync_log enable row level security;

create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_staff());
create policy profiles_admin on public.profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Ustawienia: czytają wszyscy pracownicy, zmienia administrator.
create policy stores_read on public.stores for select to authenticated using (public.is_staff());
create policy stores_admin on public.stores for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy locations_read on public.locations for select to authenticated using (public.is_staff());
create policy locations_admin on public.locations for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy sync_state_read on public.sync_state for select to authenticated using (public.is_staff());
create policy sync_log_read on public.sync_log for select to authenticated using (public.is_staff());

-- Praca magazynowa: wszyscy aktywni pracownicy.
create policy products_staff on public.products for all to authenticated using (public.is_staff()) with check (public.is_staff());
create policy product_store_links_staff on public.product_store_links for all to authenticated using (public.is_staff()) with check (public.is_staff());
create policy variants_staff on public.variants for all to authenticated using (public.is_staff()) with check (public.is_staff());
create policy variant_store_links_staff on public.variant_store_links for all to authenticated using (public.is_staff()) with check (public.is_staff());
create policy consignors_staff on public.consignors for all to authenticated using (public.is_staff()) with check (public.is_staff());
create policy contracts_staff on public.contracts for all to authenticated using (public.is_staff()) with check (public.is_staff());
create policy deliveries_staff on public.deliveries for all to authenticated using (public.is_staff()) with check (public.is_staff());
create policy units_staff on public.units for all to authenticated using (public.is_staff()) with check (public.is_staff());
create policy unit_events_staff on public.unit_events for all to authenticated using (public.is_staff()) with check (public.is_staff());
create policy sales_staff on public.sales for all to authenticated using (public.is_staff()) with check (public.is_staff());

-- ───────────────────────── Pliki umów ─────────────────────────

insert into storage.buckets (id, name, public)
values ('contracts', 'contracts', false)
on conflict (id) do nothing;

create policy contracts_files_read on storage.objects for select to authenticated
  using (bucket_id = 'contracts' and public.is_staff());
create policy contracts_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'contracts' and public.is_staff());
create policy contracts_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'contracts' and public.is_admin());

-- ───────────────────────── Dane startowe ─────────────────────────

insert into public.stores (code, name) values
  ('telefoniki', 'Telefoniki'),
  ('sneakers-depot', 'Sneakers Depot');
