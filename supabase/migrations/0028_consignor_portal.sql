-- Panel komisanta: konto do logowania, adres do wysyłki zwrotów, wypłaty, zlecenia wysyłki rzeczy do komisanta.
-- Komisant NIE jest pracownikiem: nie dostaje profilu (is_staff = false); jego dane czyta tylko serwer.

alter table public.consignors add column if not exists user_id uuid unique references auth.users (id) on delete set null;
alter table public.consignors add column if not exists address_name text;
alter table public.consignors add column if not exists address_street text;
alter table public.consignors add column if not exists address_postcode text;
alter table public.consignors add column if not exists address_city text;
alter table public.consignors add column if not exists address_country text not null default 'PL';
alter table public.consignors add column if not exists address_phone text;

-- Rzecz odłożona do wysyłki do komisanta (po zleceniu): poza stanem sklepu, nie do sprzedania.
alter table public.units drop constraint if exists units_status_check;
alter table public.units add constraint units_status_check
  check (status in ('in_transit', 'in_stock', 'reserved', 'sold', 'shipped', 'returned', 'removed', 'consignor_returned', 'consignor_hold'));

-- Konto komisanta (user_metadata.kind = 'consignor') nie dostaje profilu pracownika.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  first_user boolean;
begin
  if coalesce(new.raw_user_meta_data ->> 'kind', '') = 'consignor' then
    return new;
  end if;
  select not exists (select 1 from public.profiles) into first_user;
  insert into public.profiles (id, email, role, can_see_prices, active)
  values (new.id, new.email, case when first_user then 'admin' else 'staff' end, first_user, first_user);
  return new;
end;
$$;

-- Wypłaty dla komisanta (przelewy). Saldo = kwoty sprzedanych rzeczy (z paragonem / fakturą) − wypłaty.
create table if not exists public.consignor_payouts (
  id uuid primary key default gen_random_uuid(),
  consignor_id uuid not null references public.consignors (id) on delete cascade,
  amount numeric(12,2) not null check (amount <> 0),
  paid_at date not null default current_date,
  note text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists consignor_payouts_idx on public.consignor_payouts (consignor_id, paid_at);
alter table public.consignor_payouts enable row level security;
drop policy if exists consignor_payouts_read on public.consignor_payouts;
create policy consignor_payouts_read on public.consignor_payouts for select to authenticated using (public.is_staff());
drop policy if exists consignor_payouts_admin on public.consignor_payouts;
create policy consignor_payouts_admin on public.consignor_payouts for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Zlecenia wysyłki rzeczy z komisu do komisanta.
create table if not exists public.consignor_shipments (
  id uuid primary key default gen_random_uuid(),
  consignor_id uuid not null references public.consignors (id) on delete cascade,
  status text not null default 'requested' check (status in ('requested', 'shipped', 'cancelled')),
  method text not null check (method in ('default', 'custom', 'own_label')),
  address jsonb,
  unit_ids uuid[] not null,
  label_path text,
  label_name text,
  shipping_fee numeric(12,2),
  invoice_id uuid references public.invoices (id) on delete set null,
  tracking text,
  note text,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  processed_by uuid
);
create index if not exists consignor_shipments_idx on public.consignor_shipments (consignor_id, created_at desc);
alter table public.consignor_shipments enable row level security;
drop policy if exists consignor_shipments_staff on public.consignor_shipments;
create policy consignor_shipments_staff on public.consignor_shipments for select to authenticated using (public.is_staff());
drop policy if exists consignor_shipments_update on public.consignor_shipments;
create policy consignor_shipments_update on public.consignor_shipments for update to authenticated using (public.is_staff()) with check (public.is_staff());

insert into public.app_settings (key, value) values ('consignment', '{"shipping_fee": 20}'::jsonb)
on conflict (key) do nothing;

-- Etykiety wysyłkowe dołączane przez komisantów (PDF / JPG / PNG, do 10 MB). Zapis i odczyt tylko przez serwer.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('consignor-labels', 'consignor-labels', false, 10485760, array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do nothing;

/*
 * Rzeczy komisanta z informacją, czy sprzedaż ma dokument (paragon / faktura) – dopiero wtedy liczy się do wypłaty.
 * Kasa (sprzedaż stacjonarna) = paragon z kasy fiskalnej. Tylko dla serwera.
 */
create or replace function public.consignor_units(p_consignor_id uuid)
returns table (
  id uuid, code text, status text, payout_amount numeric, received_at timestamptz, sold_at timestamptz,
  title text, option text, image_url text, has_document boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select u.id, u.code, u.status, u.payout_amount, u.received_at, u.sold_at, p.title, v.option, p.image_url,
    (u.status in ('sold', 'shipped') and (
      exists (select 1 from public.invoice_items ii join public.invoices i on i.id = ii.invoice_id
              where ii.unit_id = u.id and i.status not in ('rejected', 'cancelled'))
      or exists (select 1 from public.pos_order_items pi where pi.unit_id = u.id and pi.status <> 'returned')
      or exists (select 1 from public.sales s join public.orders o on o.id = s.order_id
                 where s.unit_id = u.id and s.status <> 'cancelled'
                   and (o.receipt_id is not null
                        or exists (select 1 from public.receipts r where r.base_order_id = o.base_order_id)
                        or exists (select 1 from public.invoices i where i.order_id = o.id and i.status not in ('rejected', 'cancelled'))))
      or exists (select 1 from public.sales s join public.receipts r on r.base_order_id = s.base_order_id
                 where s.unit_id = u.id and s.status <> 'cancelled')
    )) as has_document
  from public.units u
  join public.variants v on v.id = u.variant_id
  join public.products p on p.id = v.product_id
  where u.owner_type = 'consignment' and u.consignor_id = p_consignor_id
  order by u.received_at desc
$$;
revoke all on function public.consignor_units(uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';
