-- 1) Zamówienia ze sklepu rezerwują sztukę (status „reserved”, w Shopify stan już −1) do wystawienia paragonu
--    albo faktury – wtedy sztuka jest sprzedana. Anulowanie zamówienia zwraca ją na stan.
-- 2) Umowy niewykorzystane: tylko zatwierdzone.
-- 3) Stan ze Shopify przy rozmiarze (Katalog), inwentaryzacja, rozliczenie rzeczy komisanta, korekty faktur.

-- ───────── 1. Rezerwacje ─────────
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
          -- Rezerwacja do paragonu / faktury (w Shopify stan już spadł o 1).
          update public.units set status = 'reserved' where id = v_unit;
          insert into public.unit_events (unit_id, type, data)
          values (v_unit, 'reserved', jsonb_build_object('sale_id', v_sale, 'order', o.name, 'source', 'shopify'));
        end if;
        v_new := v_new + 1;
      end loop;
    end loop;
  end loop;
  perform public.settle_order_units();
  return v_new;
end;
$$;

-- Sztuki zarezerwowane pod zamówienia z paragonem albo fakturą → sprzedane.
create or replace function public.settle_order_units()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  with done as (
    select distinct s.unit_id, s.id as sale_id, o.name, o.ordered_at
    from public.sales s
    join public.orders o on o.id = s.order_id
    join public.units u on u.id = s.unit_id
    where s.status = 'assigned' and u.status = 'reserved'
      and (o.receipt_id is not null
           or exists (select 1 from public.receipts r where o.base_order_id is not null and r.base_order_id = o.base_order_id)
           or exists (select 1 from public.invoices i where i.order_id = o.id and i.status not in ('rejected', 'cancelled')))
  ), upd as (
    update public.units u set status = 'sold', sold_at = coalesce(u.sold_at, d.ordered_at, now())
    from done d where u.id = d.unit_id and u.status = 'reserved'
    returning u.id, d.sale_id, d.name
  ), ev as (
    insert into public.unit_events (unit_id, type, data)
    select id, 'sold', jsonb_build_object('sale_id', sale_id, 'order', name, 'source', 'paragon / faktura') from upd
    returning 1
  )
  select count(*) into n from ev;
  return n;
end;
$$;
revoke all on function public.settle_order_units() from public, anon;
grant execute on function public.settle_order_units() to authenticated;

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
    if s.unit_id is not null and s.unit_status in ('sold', 'shipped', 'reserved') then
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
  if v_status not in ('sold', 'shipped', 'returned', 'reserved') then
    raise exception 'Zwrot dotyczy tylko sztuk sprzedanych, zarezerwowanych lub wydanych';
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

create or replace function public.swap_sale_unit(p_sale_id uuid, p_code text)
returns uuid
language plpgsql
as $$
declare
  v_sale public.sales%rowtype;
  v_new public.units%rowtype;
  v_code text := upper(trim(p_code));
  v_old_status text := 'sold';
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
    select status into v_old_status from public.units where id = v_sale.unit_id;
    update public.units u set status = 'in_stock', sold_at = null
    where u.id = v_sale.unit_id
      and u.status in ('sold', 'reserved')
      and not exists (
        select 1 from public.sales s
        where s.unit_id = v_sale.unit_id and s.status = 'assigned' and s.id <> p_sale_id
      );
    if found then
      insert into public.unit_events (unit_id, type, data)
      values (v_sale.unit_id, 'swapped', jsonb_build_object('sale_id', p_sale_id, 'replaced_by', v_new.code));
    end if;
  end if;

  update public.units
  set status = case when v_old_status = 'reserved' then 'reserved' else 'sold' end,
      sold_at = case when v_old_status = 'reserved' then null else v_sale.sold_at end
  where id = v_new.id;
  insert into public.unit_events (unit_id, type, data)
  values (v_new.id, case when v_old_status = 'reserved' then 'reserved' else 'sold' end, jsonb_build_object('sale_id', p_sale_id, 'order', v_sale.order_ref, 'swapped', true));

  update public.sales
  set unit_id = v_new.id, variant_id = v_new.variant_id, status = 'assigned'
  where id = p_sale_id;

  return v_new.id;
end;
$$;

create or replace function public.receive_in_transit(p_unit_ids uuid[])
returns table (unit_id uuid, variant_id uuid, location_id uuid, to_status text)
language plpgsql
as $$
declare
  u public.units%rowtype;
  v_sold boolean;
begin
  for u in select * from public.units where id = any(p_unit_ids) and status = 'in_transit' for update loop
    select exists (select 1 from public.sales s where s.unit_id = u.id and s.status = 'assigned') into v_sold;
    -- Pod zamówienie: rezerwacja do paragonu / faktury.
    update public.units
    set status = case when v_sold then 'reserved' else 'in_stock' end,
        received_at = now()
    where id = u.id;
    insert into public.unit_events (unit_id, type, data)
    values (u.id, 'status', jsonb_build_object('from', 'in_transit', 'to', case when v_sold then 'reserved' else 'in_stock' end, 'for_order', v_sold));
    unit_id := u.id; variant_id := u.variant_id; location_id := u.location_id;
    to_status := case when v_sold then 'reserved' else 'in_stock' end;
    return next;
  end loop;
  perform public.settle_order_units();
end;
$$;

-- ───────── 2. Umowy niewykorzystane: tylko zatwierdzone ─────────
create or replace view public.contracts_unused
with (security_invoker = true) as
select c.id
from public.contracts c
where c.status = 'accepted'
  and not exists (select 1 from public.units u where u.contract_id = c.id and u.status not in ('removed', 'consignor_returned'));
grant select on public.contracts_unused to authenticated;

-- ───────── 3. Stan ze Shopify przy rozmiarze (Katalog) ─────────
alter table public.variant_store_links add column if not exists shopify_qty int;
alter table public.variant_store_links add column if not exists shopify_qty_at timestamptz;

create or replace function public.set_shopify_qty(p_store_id uuid, p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  update public.variant_store_links l
  set shopify_qty = (r ->> 'qty')::int, shopify_qty_at = now()
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
  where l.store_id = p_store_id and l.shopify_inventory_item_id = r ->> 'item'
    and l.shopify_qty is distinct from (r ->> 'qty')::int;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.set_shopify_qty(uuid, jsonb) from public, anon, authenticated;

-- ───────── 4. Inwentaryzacja ─────────
create table if not exists public.inventory_reports (
  id uuid primary key default gen_random_uuid(),
  location_id uuid references public.locations (id) on delete set null,
  scanned int not null default 0,
  expected int not null default 0,
  missing jsonb not null default '[]',
  extra jsonb not null default '[]',
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
alter table public.inventory_reports enable row level security;
drop policy if exists inventory_reports_staff on public.inventory_reports;
create policy inventory_reports_staff on public.inventory_reports for all to authenticated using (public.is_staff()) with check (public.is_staff());

-- ───────── 5. Rozliczenie rzeczy komisanta (zapłacono) ─────────
alter table public.units add column if not exists consignor_payout_id uuid references public.consignor_payouts (id) on delete set null;
alter table public.consignor_payouts add column if not exists unit_ids uuid[];

-- ───────── 6. Korekty faktur ─────────
alter table public.invoices add column if not exists kind text not null default 'invoice';
alter table public.invoices drop constraint if exists invoices_kind_check;
alter table public.invoices add constraint invoices_kind_check check (kind in ('invoice', 'correction'));
alter table public.invoices add column if not exists corrected_invoice_id uuid references public.invoices (id) on delete restrict;
alter table public.invoices add column if not exists correction jsonb;   -- {reason, type, before: [...pozycje], diff: {...}}

create or replace function public.create_invoice(p_invoice jsonb, p_items jsonb)
returns table (id uuid, number text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_year int := extract(year from coalesce((p_invoice->>'issue_date')::date, current_date));
  v_series text := coalesce(nullif(p_invoice->>'series', ''), 'FVM');
  v_seq int;
  v_id uuid;
  v_number text;
begin
  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 and coalesce(p_invoice->>'kind', 'invoice') = 'invoice' then
    raise exception 'Faktura musi mieć co najmniej jedną pozycję';
  end if;
  v_seq := public.next_invoice_seq(v_series, v_year);
  v_number := v_series || '/' || v_seq || '/' || v_year;
  insert into public.invoices (series, year, seq, number, issue_date, sale_date, place, seller, buyer, currency, payment_method, paid, paid_at,
    due_date, total_gross, net_23, vat_23, margin_total, notes, order_id, pos_order_id, created_by, kind, corrected_invoice_id, correction)
  values (v_series, v_year, v_seq, v_number,
    coalesce((p_invoice->>'issue_date')::date, current_date), coalesce((p_invoice->>'sale_date')::date, current_date),
    p_invoice->>'place', p_invoice->'seller', p_invoice->'buyer', coalesce(p_invoice->>'currency', 'PLN'),
    coalesce(p_invoice->>'payment_method', 'transfer'), coalesce((p_invoice->>'paid')::boolean, false), (p_invoice->>'paid_at')::date,
    (p_invoice->>'due_date')::date, (p_invoice->>'total_gross')::numeric, (p_invoice->>'net_23')::numeric, (p_invoice->>'vat_23')::numeric,
    (p_invoice->>'margin_total')::numeric, p_invoice->>'notes', (p_invoice->>'order_id')::uuid, (p_invoice->>'pos_order_id')::uuid,
    (p_invoice->>'created_by')::uuid, coalesce(p_invoice->>'kind', 'invoice'), (p_invoice->>'corrected_invoice_id')::uuid, p_invoice->'correction')
  returning invoices.id into v_id;
  insert into public.invoice_items (invoice_id, position, name, quantity, unit, unit_price_gross, total_gross, vat, unit_id, sale_id, pos_item_id)
  select v_id, e.ord::int, e.i->>'name', coalesce((e.i->>'quantity')::numeric, 1), coalesce(e.i->>'unit', 'szt.'),
    (e.i->>'unit_price_gross')::numeric, (e.i->>'total_gross')::numeric, e.i->>'vat', (e.i->>'unit_id')::uuid, (e.i->>'sale_id')::uuid, (e.i->>'pos_item_id')::uuid
  from jsonb_array_elements(p_items) with ordinality as e(i, ord);
  return query select v_id, v_number;
end;
$$;
revoke all on function public.create_invoice(jsonb, jsonb) from public, anon, authenticated;

-- Usunięcie faktury, której nie ma w KSeF: numer wraca do puli, jeśli to ostatnia faktura w serii i roku.
create or replace function public.delete_invoice(p_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  inv public.invoices%rowtype;
begin
  select * into inv from public.invoices where id = p_id for update;
  if not found then raise exception 'Nie ma takiej faktury'; end if;
  if inv.ksef_number is not null or inv.status in ('accepted', 'sending') then
    raise exception 'Faktura jest w KSeF – nie można jej usunąć, wystaw korektę';
  end if;
  if exists (select 1 from public.invoices c where c.corrected_invoice_id = p_id) then
    raise exception 'Do tej faktury jest korekta';
  end if;
  delete from public.invoices where id = p_id;
  update public.invoice_counters set last = last - 1 where series = inv.series and year = inv.year and last = inv.seq;
  return inv.number;
end;
$$;
revoke all on function public.delete_invoice(uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';
