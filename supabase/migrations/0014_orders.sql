-- Zamówienia ze sklepów Shopify: wysyłka, płatność, status (Nowe / Wysłane / Dostarczone / Problem)
-- oraz przesyłki z Furgonetki. Linie sprzedaży (sales) dalej przypisują sztuki; łączą się z zamówieniem po numerze.

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id),
  shopify_order_id text not null unique,          -- gid://shopify/Order/123
  shopify_legacy_id text,                         -- 123
  name text not null,                             -- #2932
  number text not null,                           -- 2932
  ordered_at timestamptz not null,
  shop_updated_at timestamptz,
  cancelled_at timestamptz,
  customer_name text,
  email text,
  phone text,
  shipping_address jsonb,
  shipping_method text,
  shipping_price numeric(12,2),
  pickup_point text,                              -- kod paczkomatu / punktu, jeśli rozpoznany
  payment_gateways text[] not null default '{}',
  financial_status text,                          -- PAID, PENDING, REFUNDED…
  cod boolean not null default false,             -- za pobraniem
  total numeric(12,2),
  outstanding numeric(12,2),
  currency text,
  note text,
  attributes jsonb not null default '[]',
  line_items jsonb not null default '[]',
  fulfillments jsonb not null default '[]',
  status text not null default 'new' check (status in ('new', 'shipped', 'delivered', 'problem', 'cancelled')),
  status_detail text,                             -- opis ostatniego zdarzenia przewoźnika
  status_changed_at timestamptz not null default now(),
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists orders_status_idx on public.orders (status, ordered_at desc);
create index if not exists orders_ordered_idx on public.orders (ordered_at desc);
create index if not exists orders_number_idx on public.orders (number);

create table if not exists public.shipments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.orders (id) on delete set null,
  provider text not null default 'furgonetka',
  external_id text not null,                      -- package_id w Furgonetce
  service text,                                   -- inpost, dpd…
  tracking_number text,
  tracking_url text,
  state text,                                     -- stan przesyłki u przewoźnika (ordered, transit, delivered…)
  state_description text,
  state_at timestamptz,
  reference text,                                 -- numer zamówienia zapisany w przesyłce
  created_in_app boolean not null default false,
  created_by uuid references public.profiles (id),
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, external_id)
);
create index if not exists shipments_order_idx on public.shipments (order_id);
create index if not exists shipments_tracking_idx on public.shipments (tracking_number);

alter table public.sales add column if not exists order_id uuid references public.orders (id) on delete set null;
create index if not exists sales_order_idx on public.sales (order_id);
create index if not exists sales_order_ref_idx on public.sales (order_ref) where order_id is null;

-- Tokeny integracji (Furgonetka OAuth). Tylko klucz serwera – bez polityk dla zalogowanych.
create table if not exists public.integration_tokens (
  provider text primary key,
  access_token text not null,
  refresh_token text,
  expires_at timestamptz,
  refreshing_until timestamptz,
  connected_by uuid references public.profiles (id),
  updated_at timestamptz not null default now()
);
alter table public.integration_tokens enable row level security;

alter table public.orders enable row level security;
alter table public.shipments enable row level security;
drop policy if exists orders_staff on public.orders;
create policy orders_staff on public.orders for select to authenticated using (public.is_staff());
drop policy if exists shipments_staff on public.shipments;
create policy shipments_staff on public.shipments for select to authenticated using (public.is_staff());

-- Łączy linie sprzedaży z Base z zamówieniami Shopify (numer zamówienia, #numer albo ID Shopify).
create or replace function public.link_sales_to_orders()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  update public.sales s
     set order_id = o.id
    from public.orders o
   where s.order_id is null
     and s.order_ref is not null
     and (s.store_id is null or s.store_id = o.store_id)
     and btrim(s.order_ref) in (o.number, o.name, o.shopify_legacy_id);
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.link_sales_to_orders() from public, anon, authenticated;

-- Dane nadawcy do etykiet (edytowalne w Ustawieniach).
insert into public.app_settings (key, value) values
  ('shipping_sender', jsonb_build_object(
     'company', 'SNEAKERS DEPOT SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ',
     'name', '',
     'street', 'Długa 13',
     'postcode', '61-850',
     'city', 'Poznań',
     'email', 'sneakersdepot.pl@gmail.com',
     'phone', '+48503169256',
     'inpost_send_point', 'any_apm',
     'cod_iban', ''))
on conflict (key) do nothing;
