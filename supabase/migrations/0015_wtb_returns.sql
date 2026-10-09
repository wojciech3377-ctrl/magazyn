-- WTB (want to buy): lista butów, które chcemy odkupić, z grafiką do publikacji.
-- Oraz status „Zwrócone” dla zamówień.

create table if not exists public.wtb_items (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.products (id) on delete set null,
  variant_id uuid references public.variants (id) on delete set null,
  title text not null,
  size text,
  sku text,
  image_url text,
  note text,
  status text not null default 'active' check (status in ('active', 'bought', 'cancelled')),
  source text not null default 'manual' check (source in ('manual', 'catalog', 'order', 'sale')),
  order_id uuid references public.orders (id) on delete set null,
  order_line_id text,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
create index if not exists wtb_items_status_idx on public.wtb_items (status, created_at desc);
-- Ta sama pozycja zamówienia nie trafia na aktywną listę dwa razy (np. podwójne kliknięcie).
create unique index if not exists wtb_items_order_line_uq on public.wtb_items (order_id, order_line_id)
  where status = 'active' and order_line_id is not null;

alter table public.wtb_items enable row level security;
drop policy if exists wtb_items_staff on public.wtb_items;
create policy wtb_items_staff on public.wtb_items for all to authenticated using (public.is_staff()) with check (public.is_staff());

alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status in ('new', 'shipped', 'delivered', 'problem', 'cancelled', 'returned'));
