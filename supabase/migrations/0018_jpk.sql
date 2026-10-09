-- JPK: paragony (z Base, z drukarki, wpisane ręcznie), cena sprzedaży linii, numer umowy ze skanu.

create table if not exists public.receipts (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'manual' check (source in ('base', 'printer', 'manual')),
  base_receipt_id bigint unique,
  number text,                                    -- numer paragonu
  issued_at timestamptz not null default now(),
  base_order_id bigint,                           -- zamówienie w Base (sklep)
  pos_order_id uuid references public.pos_orders (id) on delete cascade,
  currency text,
  items jsonb not null default '[]',
  created_by uuid references public.profiles (id) default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists receipts_issued_idx on public.receipts (issued_at desc);
create index if not exists receipts_base_order_idx on public.receipts (base_order_id);
create index if not exists receipts_pos_idx on public.receipts (pos_order_id);

alter table public.receipts enable row level security;
drop policy if exists receipts_read on public.receipts;
create policy receipts_read on public.receipts for select to authenticated using (public.is_staff());
drop policy if exists receipts_insert on public.receipts;
create policy receipts_insert on public.receipts for insert to authenticated with check (public.is_staff() and source = 'manual');
drop policy if exists receipts_update on public.receipts;
create policy receipts_update on public.receipts for update to authenticated using (public.is_staff() and source = 'manual') with check (public.is_staff() and source = 'manual');
drop policy if exists receipts_delete on public.receipts;
create policy receipts_delete on public.receipts for delete to authenticated using (public.is_admin() and source = 'manual');

-- Cena brutto linii sprzedaży (z zamówienia w Base).
alter table public.sales add column if not exists price numeric(12,2);
create index if not exists sales_base_order_idx on public.sales (base_order_id);

-- Numer umowy z dokumentu (np. NR00512, 190/2026, FATTURA 230/25) – głównie dla wgranych skanów.
alter table public.contracts add column if not exists doc_number text;
