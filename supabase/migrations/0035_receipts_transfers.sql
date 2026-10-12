-- 0035: paragony (dokument sprzedaży bez danych nabywcy, poza KSeF) i przesunięcia między magazynami.

/* ---------- Paragony PAR/miesiąc/numer ---------- */

alter table public.invoices drop constraint if exists invoices_kind_check;
alter table public.invoices add constraint invoices_kind_check check (kind in ('invoice', 'correction', 'receipt'));

-- Numer paragonu PAR/10/1 powtarza się co rok – unikalny jest numer w roku (faktury mają rok w numerze).
alter table public.invoices drop constraint if exists invoices_number_key;
create unique index if not exists invoices_year_number_uq on public.invoices (year, number);

-- Do zamówienia / sprzedaży stacjonarnej może być paragon i (później, na prośbę klienta) faktura.
drop index if exists public.invoices_order_uq;
drop index if exists public.invoices_pos_uq;
create unique index if not exists invoices_order_uq on public.invoices (order_id, (kind = 'receipt'))
  where order_id is not null and status not in ('rejected', 'cancelled') and kind <> 'correction';
create unique index if not exists invoices_pos_uq on public.invoices (pos_order_id, (kind = 'receipt'))
  where pos_order_id is not null and status not in ('rejected', 'cancelled') and kind <> 'correction';

create or replace function public.create_invoice(p_invoice jsonb, p_items jsonb)
returns table (id uuid, number text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind text := coalesce(nullif(p_invoice->>'kind', ''), 'invoice');
  v_date date := coalesce((p_invoice->>'issue_date')::date, current_date);
  v_year int := extract(year from v_date);
  v_series text := coalesce(nullif(p_invoice->>'series', ''), 'FVM');
  v_seq int;
  v_id uuid;
  v_number text;
begin
  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 and v_kind in ('invoice', 'receipt') then
    raise exception 'Dokument musi mieć co najmniej jedną pozycję';
  end if;
  if v_kind = 'receipt' then
    -- Paragon: osobna numeracja w każdym miesiącu, od 1 (seria „PAR/10” w roku 2026 → PAR/10/1, PAR/10/2…).
    v_series := 'PAR/' || to_char(v_date, 'MM');
    v_seq := public.next_invoice_seq(v_series, v_year);
    v_number := v_series || '/' || v_seq;
  else
    v_seq := public.next_invoice_seq(v_series, v_year);
    v_number := v_series || '/' || v_seq || '/' || v_year;
  end if;
  insert into public.invoices (series, year, seq, number, issue_date, sale_date, place, seller, buyer, currency, payment_method, paid, paid_at,
    due_date, total_gross, net_23, vat_23, margin_total, notes, order_id, pos_order_id, created_by, kind, corrected_invoice_id, correction)
  values (v_series, v_year, v_seq, v_number,
    v_date, coalesce((p_invoice->>'sale_date')::date, current_date),
    p_invoice->>'place', p_invoice->'seller', p_invoice->'buyer', coalesce(p_invoice->>'currency', 'PLN'),
    coalesce(p_invoice->>'payment_method', 'transfer'), coalesce((p_invoice->>'paid')::boolean, false), (p_invoice->>'paid_at')::date,
    (p_invoice->>'due_date')::date, (p_invoice->>'total_gross')::numeric, (p_invoice->>'net_23')::numeric, (p_invoice->>'vat_23')::numeric,
    (p_invoice->>'margin_total')::numeric, p_invoice->>'notes', (p_invoice->>'order_id')::uuid, (p_invoice->>'pos_order_id')::uuid,
    (p_invoice->>'created_by')::uuid, v_kind, (p_invoice->>'corrected_invoice_id')::uuid, p_invoice->'correction')
  returning invoices.id into v_id;
  insert into public.invoice_items (invoice_id, position, name, quantity, unit, unit_price_gross, total_gross, vat, unit_id, sale_id, pos_item_id)
  select v_id, e.ord::int, e.i->>'name', coalesce((e.i->>'quantity')::numeric, 1), coalesce(e.i->>'unit', 'szt.'),
    (e.i->>'unit_price_gross')::numeric, (e.i->>'total_gross')::numeric, e.i->>'vat', (e.i->>'unit_id')::uuid, (e.i->>'sale_id')::uuid, (e.i->>'pos_item_id')::uuid
  from jsonb_array_elements(p_items) with ordinality as e(i, ord);
  return query select v_id, v_number;
end;
$$;
revoke all on function public.create_invoice(jsonb, jsonb) from public, anon, authenticated;


/* ---------- Przesunięcia między magazynami ---------- */

create table if not exists public.stock_transfers (
  id uuid primary key default gen_random_uuid(),
  number serial,
  from_location_id uuid not null references public.locations (id),
  to_location_id uuid not null references public.locations (id),
  status text not null default 'in_transit' check (status in ('in_transit', 'received', 'cancelled')),
  note text,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  received_at timestamptz,
  received_by uuid references public.profiles (id),
  check (from_location_id <> to_location_id)
);
create index if not exists stock_transfers_status_idx on public.stock_transfers (status, created_at desc);

create table if not exists public.stock_transfer_items (
  transfer_id uuid not null references public.stock_transfers (id) on delete cascade,
  unit_id uuid not null references public.units (id) on delete cascade,
  received_at timestamptz,
  primary key (transfer_id, unit_id)
);
create index if not exists stock_transfer_items_unit_idx on public.stock_transfer_items (unit_id);

-- Sztuka w drodze między magazynami (lokalizacja = magazyn docelowy, status in_transit).
alter table public.units add column if not exists transfer_id uuid references public.stock_transfers (id) on delete set null;
create index if not exists units_transfer_idx on public.units (transfer_id) where transfer_id is not null;

alter table public.stock_transfers enable row level security;
alter table public.stock_transfer_items enable row level security;
drop policy if exists stock_transfers_staff on public.stock_transfers;
create policy stock_transfers_staff on public.stock_transfers for all to authenticated using (public.is_staff()) with check (public.is_staff());
drop policy if exists stock_transfer_items_staff on public.stock_transfer_items;
create policy stock_transfer_items_staff on public.stock_transfer_items for all to authenticated using (public.is_staff()) with check (public.is_staff());

/*
 * Wysyłka sztuk na inny magazyn: tylko sztuki na stanie w magazynie źródłowym. Sztuki dostają status „w drodze”
 * i lokalizację docelową (stan w Shopify zdejmuje serwer: −1 w źródle, +1 w celu dopiero przy przyjęciu).
 */
create or replace function public.create_stock_transfer(p_from uuid, p_to uuid, p_unit_ids uuid[], p_note text default null)
returns uuid
language plpgsql
as $$
declare
  v_id uuid;
  v_bad text;
begin
  if p_from = p_to then raise exception 'Wybierz inny magazyn docelowy'; end if;
  if coalesce(array_length(p_unit_ids, 1), 0) = 0 then raise exception 'Zeskanuj co najmniej jedną sztukę'; end if;
  select string_agg(u.code, ', ') into v_bad from public.units u
  where u.id = any(p_unit_ids) and (u.status <> 'in_stock' or u.location_id <> p_from);
  if v_bad is not null then raise exception 'Sztuki nie są na stanie w magazynie źródłowym: %', v_bad; end if;
  if (select count(*) from public.units where id = any(p_unit_ids)) <> (select count(distinct x) from unnest(p_unit_ids) x) then
    raise exception 'Nie ma takiej sztuki';
  end if;
  insert into public.stock_transfers (from_location_id, to_location_id, note, created_by)
  values (p_from, p_to, nullif(trim(coalesce(p_note, '')), ''), auth.uid()) returning id into v_id;
  insert into public.stock_transfer_items (transfer_id, unit_id) select v_id, x from unnest(p_unit_ids) x;
  update public.units set status = 'in_transit', location_id = p_to, transfer_id = v_id where id = any(p_unit_ids);
  insert into public.unit_events (unit_id, type, data, created_by)
  select x, 'transfer', jsonb_build_object('transfer_id', v_id, 'from', p_from, 'to', p_to), auth.uid() from unnest(p_unit_ids) x;
  return v_id;
end;
$$;

/*
 * Przyjęcie towaru „w drodze” (umowa, dostawa albo przesunięcie): jak w 0034, a przy przesunięciu dodatkowo
 * zaznacza sztukę jako dotarłą i zamyka przesunięcie, gdy dotarło wszystko.
 */
create or replace function public.receive_in_transit(p_unit_ids uuid[])
returns table (unit_id uuid, variant_id uuid, location_id uuid, to_status text)
language plpgsql
as $$
declare
  u public.units%rowtype;
  v_sold boolean;
  v_transfers uuid[] := '{}';
begin
  for u in select * from public.units where id = any(p_unit_ids) and status = 'in_transit' for update loop
    select exists (select 1 from public.sales s where s.unit_id = u.id and s.status = 'assigned') into v_sold;
    -- Pod zamówienie: rezerwacja do paragonu / faktury.
    update public.units
    set status = case when v_sold then 'reserved' else 'in_stock' end,
        received_at = now(), transfer_id = null
    where id = u.id;
    insert into public.unit_events (unit_id, type, data)
    values (u.id, 'status', jsonb_build_object('from', 'in_transit', 'to', case when v_sold then 'reserved' else 'in_stock' end, 'for_order', v_sold)
      || case when u.transfer_id is not null then jsonb_build_object('transfer_id', u.transfer_id) else '{}'::jsonb end);
    if u.transfer_id is not null then
      update public.stock_transfer_items i set received_at = now() where i.transfer_id = u.transfer_id and i.unit_id = u.id;
      v_transfers := v_transfers || u.transfer_id;
    end if;
    unit_id := u.id; variant_id := u.variant_id; location_id := u.location_id;
    to_status := case when v_sold then 'reserved' else 'in_stock' end;
    return next;
  end loop;
  update public.stock_transfers t set status = 'received', received_at = now(), received_by = auth.uid()
  where t.id = any(v_transfers) and t.status = 'in_transit'
    and not exists (select 1 from public.units x where x.transfer_id = t.id and x.status = 'in_transit');
  perform public.settle_order_units();
end;
$$;

/* Przyjęcie przesunięcia (wszystkich albo wybranych sztuk) w magazynie docelowym. */
create or replace function public.receive_stock_transfer(p_id uuid, p_unit_ids uuid[] default null)
returns table (unit_id uuid, variant_id uuid, location_id uuid, to_status text)
language plpgsql
as $$
declare
  v_ids uuid[];
begin
  select array_agg(u.id) into v_ids from public.units u
  where u.transfer_id = p_id and u.status = 'in_transit' and (p_unit_ids is null or u.id = any(p_unit_ids));
  if v_ids is null then return; end if;
  return query select * from public.receive_in_transit(v_ids);
end;
$$;

/* Anulowanie przesunięcia: sztuki jeszcze w drodze wracają na stan magazynu źródłowego. */
create or replace function public.cancel_stock_transfer(p_id uuid)
returns table (unit_id uuid, variant_id uuid, location_id uuid)
language plpgsql
as $$
declare
  t public.stock_transfers%rowtype;
begin
  select * into t from public.stock_transfers where id = p_id for update;
  if not found or t.status <> 'in_transit' then raise exception 'To przesunięcie nie jest w drodze'; end if;
  return query
  with back as (
    update public.units u set status = 'in_stock', location_id = t.from_location_id, transfer_id = null
    where u.transfer_id = p_id and u.status = 'in_transit'
    returning u.id, u.variant_id, u.location_id
  ), ev as (
    insert into public.unit_events (unit_id, type, data, created_by)
    select b.id, 'transfer_cancelled', jsonb_build_object('transfer_id', p_id), auth.uid() from back b returning 1
  )
  select b.id, b.variant_id, b.location_id from back b;
  update public.units set transfer_id = null where transfer_id = p_id;
  update public.stock_transfers set status = case when exists (select 1 from public.stock_transfer_items i where i.transfer_id = p_id and i.received_at is not null) then 'received' else 'cancelled' end,
    received_at = now(), received_by = auth.uid()
  where id = p_id;
end;
$$;

grant execute on function public.create_stock_transfer(uuid, uuid, uuid[], text) to authenticated;
grant execute on function public.receive_stock_transfer(uuid, uuid[]) to authenticated;
grant execute on function public.cancel_stock_transfer(uuid) to authenticated;

notify pgrst, 'reload schema';
