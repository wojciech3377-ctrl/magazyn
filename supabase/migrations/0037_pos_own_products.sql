-- 0037: własne produkty (np. usługa „Renowacja obuwia”, z liczeniem stanu albo bez) i pozycje Kasy bez sztuki
-- z magazynu (wpisane ręcznie, np. towar na zamówienie). Stawki PTU jako litery A–F (procent w Ustawieniach).

create table if not exists public.pos_products (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  price numeric(12,2) check (price is null or price >= 0),
  ptu text not null default 'A' check (ptu ~ '^[A-G]$'),
  track_stock boolean not null default false,
  stock int not null default 0,
  code text,                                   -- własny kod / EAN do skanowania (opcjonalnie)
  active boolean not null default true,
  created_by uuid references public.profiles (id) default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists pos_products_name_idx on public.pos_products (lower(name));
alter table public.pos_products enable row level security;
drop policy if exists pos_products_staff on public.pos_products;
create policy pos_products_staff on public.pos_products for all to authenticated using (public.is_staff()) with check (public.is_staff());

-- Pozycja Kasy: sztuka z magazynu albo pozycja bez sztuki (własny produkt / wpisana ręcznie).
alter table public.pos_order_items alter column unit_id drop not null;
alter table public.pos_order_items add column if not exists name text;
alter table public.pos_order_items add column if not exists ptu text check (ptu is null or ptu ~ '^[A-G]$');
alter table public.pos_order_items add column if not exists quantity numeric(10,3) not null default 1 check (quantity > 0);
alter table public.pos_order_items add column if not exists product_id uuid references public.pos_products (id) on delete set null;
alter table public.pos_order_items drop constraint if exists pos_order_items_unit_or_name;
alter table public.pos_order_items add constraint pos_order_items_unit_or_name check (unit_id is not null or (name is not null and ptu is not null));

-- p_items: [{"unit_id": "...", "price": 499}] albo [{"name": "Renowacja", "ptu": "A", "price": 120, "quantity": 1, "product_id": "..."}]
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
  v_price numeric;
  v_qty numeric;
  v_prod public.pos_products%rowtype;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Koszyk jest pusty';
  end if;

  insert into public.pos_orders (store_id, payment_method, customer, note)
  values (p_store_id, coalesce(p_payment, 'card'), nullif(trim(p_customer), ''), nullif(trim(p_note), ''))
  returning * into v_order;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_price := round((v_item ->> 'price')::numeric, 2);
    if v_price is null or v_price < 0 then raise exception 'Zła cena pozycji'; end if;
    if coalesce(v_item ->> 'unit_id', '') <> '' then
      update public.units
      set status = 'sold', sold_at = now()
      where id = (v_item ->> 'unit_id')::uuid and status in ('in_stock', 'reserved')
      returning * into v_unit;
      if not found then
        raise exception 'Sztuka % nie jest już na stanie (sprzedana albo wydana)',
          coalesce((select code from public.units where id = (v_item ->> 'unit_id')::uuid), v_item ->> 'unit_id');
      end if;
      insert into public.pos_order_items (order_id, unit_id, price)
      values (v_order.id, v_unit.id, v_price);
      v_total := v_total + v_price;
      insert into public.unit_events (unit_id, type, data)
      values (v_unit.id, 'sold', jsonb_build_object('order', v_order.code, 'pos_order_id', v_order.id, 'price', v_price));
    else
      -- Pozycja bez sztuki z magazynu: nazwa i stawka PTU podane w Kasie (własny produkt albo wpisany ręcznie).
      v_qty := greatest(coalesce((v_item ->> 'quantity')::numeric, 1), 0.001);
      if coalesce(trim(v_item ->> 'name'), '') = '' then raise exception 'Podaj nazwę pozycji'; end if;
      if coalesce(v_item ->> 'ptu', '') !~ '^[A-G]$' then raise exception 'Wybierz stawkę PTU (A–F) dla: %', v_item ->> 'name'; end if;
      if coalesce(v_item ->> 'product_id', '') <> '' then
        select * into v_prod from public.pos_products where id = (v_item ->> 'product_id')::uuid for update;
        if found and v_prod.track_stock then
          if v_prod.stock < v_qty then raise exception 'Produktu „%” nie ma na stanie (zostało %)', v_prod.name, v_prod.stock; end if;
          update public.pos_products set stock = stock - ceil(v_qty)::int where id = v_prod.id;
        end if;
      end if;
      insert into public.pos_order_items (order_id, name, ptu, quantity, price, product_id)
      values (v_order.id, left(trim(v_item ->> 'name'), 120), v_item ->> 'ptu', v_qty, v_price,
        nullif(v_item ->> 'product_id', '')::uuid);
      v_total := v_total + round(v_price * v_qty, 2);
    end if;
  end loop;

  update public.pos_orders set total = v_total where id = v_order.id;
  return v_order.id;
end;
$$;

/* Paragon z drukarki: stawka z pozycji (procent przypisany do litery w chwili wystawienia). */
create or replace function public.finish_receipt_job(p_printer uuid, p_id uuid, p_ok boolean, p_number text, p_error text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  j public.receipt_jobs%rowtype;
begin
  select * into j from public.receipt_jobs where id = p_id and printer_id = p_printer for update;
  if not found then raise exception 'Nie ma takiego zadania dla tej drukarki'; end if;
  if j.status = 'printed' then return 'printed'; end if;
  if j.status <> 'printing' then raise exception 'Zadanie ma status %', j.status; end if;
  if not p_ok then
    update public.receipt_jobs set status = 'error', error = left(coalesce(p_error, 'błąd drukarki'), 1000) where id = p_id;
    return 'error';
  end if;
  update public.receipt_jobs set status = 'printed', receipt_number = left(p_number, 60), printed_at = now(), error = null where id = p_id;
  if j.source <> 'test' then
    insert into public.receipts (source, number, issued_at, pos_order_id, order_id, job_id, currency, items, created_by)
    values ('printer', left(p_number, 60), now(), j.pos_order_id, j.order_id, j.id, 'PLN',
      (select coalesce(jsonb_agg(jsonb_build_object('name', l->>'name', 'quantity', (l->>'qty')::numeric, 'price_brutto', (l->>'price')::numeric,
        'tax_rate', coalesce(nullif(l->>'rate', '')::numeric, case when l->>'ptu' = 'A' then 23 else 0 end), 'ptu', l->>'ptu')), '[]'::jsonb)
       from jsonb_array_elements(j.lines) l),
      j.created_by);
    if j.order_id is not null then
      update public.orders set receipt_at = now() where id = j.order_id;
      perform public.settle_order_units();
    end if;
  end if;
  return 'printed';
end;
$$;
revoke all on function public.finish_receipt_job(uuid, uuid, boolean, text, text) from public, anon, authenticated;

notify pgrst, 'reload schema';
