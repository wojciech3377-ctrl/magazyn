-- Cena w sklepie (z Shopify) i sprzedaż stacjonarna (kasa ze skanerem).
-- Wklej całość w Supabase → SQL Editor → Run.

alter table public.variant_store_links add column if not exists price numeric(12, 2);

create sequence if not exists public.pos_order_number_seq start 1;

create table if not exists public.pos_orders (
  id uuid primary key default gen_random_uuid(),
  number bigint not null unique default nextval('public.pos_order_number_seq'),
  code text generated always as ('SP' || lpad(number::text, 6, '0')) stored,
  store_id uuid not null references public.stores (id),
  payment_method text not null default 'card' check (payment_method in ('cash', 'card', 'transfer', 'blik', 'other')),
  customer text,
  note text,
  total numeric(12, 2) not null default 0,
  base_sync_status text not null default 'pending' check (base_sync_status in ('pending', 'ok', 'error')),
  base_sync_error text,
  base_pending jsonb not null default '[]'::jsonb,
  created_by uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now()
);

create table if not exists public.pos_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.pos_orders (id) on delete cascade,
  unit_id uuid not null references public.units (id),
  price numeric(12, 2) not null check (price >= 0),
  status text not null default 'sold' check (status in ('sold', 'returned')),
  unique (order_id, unit_id)
);
create index if not exists pos_order_items_unit_idx on public.pos_order_items (unit_id);

alter table public.pos_orders enable row level security;
alter table public.pos_order_items enable row level security;
do $$
declare t text;
begin
  foreach t in array array['pos_orders', 'pos_order_items'] loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_staff())', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.is_staff())', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.is_staff()) with check (public.is_staff())', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.is_admin())', t || '_delete', t);
  end loop;
end $$;

-- Sprzedaż stacjonarna: sztuki muszą być na stanie; wszystko albo nic.
-- p_items: [{"unit_id": "...", "price": 499.00}, ...]
create or replace function public.create_pos_order(
  p_store_id uuid,
  p_items jsonb,
  p_payment text default 'card',
  p_customer text default null,
  p_note text default null
)
returns uuid
language plpgsql
as $$
declare
  v_order public.pos_orders%rowtype;
  v_item jsonb;
  v_unit public.units%rowtype;
  v_total numeric := 0;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Koszyk jest pusty';
  end if;

  insert into public.pos_orders (store_id, payment_method, customer, note)
  values (p_store_id, coalesce(p_payment, 'card'), nullif(trim(p_customer), ''), nullif(trim(p_note), ''))
  returning * into v_order;

  for v_item in select * from jsonb_array_elements(p_items) loop
    update public.units
    set status = 'sold', sold_at = now()
    where id = (v_item ->> 'unit_id')::uuid and status in ('in_stock', 'reserved')
    returning * into v_unit;
    if not found then
      raise exception 'Sztuka % nie jest już na stanie (sprzedana albo wydana)',
        coalesce((select code from public.units where id = (v_item ->> 'unit_id')::uuid), v_item ->> 'unit_id');
    end if;

    insert into public.pos_order_items (order_id, unit_id, price)
    values (v_order.id, v_unit.id, round((v_item ->> 'price')::numeric, 2));
    v_total := v_total + round((v_item ->> 'price')::numeric, 2);

    insert into public.unit_events (unit_id, type, data)
    values (v_unit.id, 'sold', jsonb_build_object('order', v_order.code, 'pos_order_id', v_order.id, 'price', (v_item ->> 'price')::numeric));
  end loop;

  update public.pos_orders set total = v_total where id = v_order.id;
  return v_order.id;
end;
$$;

-- Zwrot zamyka też pozycję sprzedaży stacjonarnej.
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

  update public.sales set status = 'cancelled' where unit_id = p_unit_id and status = 'assigned';
  update public.pos_order_items set status = 'returned' where unit_id = p_unit_id and status = 'sold';

  update public.units
  set status = case when p_back_to_stock then 'in_stock' else 'returned' end,
      sold_at = null
  where id = p_unit_id;

  insert into public.unit_events (unit_id, type, data)
  values (p_unit_id, 'returned', jsonb_build_object('back_to_stock', p_back_to_stock, 'from', v_status));
end;
$$;
