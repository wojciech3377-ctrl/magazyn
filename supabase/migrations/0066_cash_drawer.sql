-- 0066: gotówka w kasie (sprzedaż stacjonarna): stan = sprzedaż gotówką − zwroty + wpłaty − wypłaty (zabrane / wyzerowanie).
create table if not exists public.cash_movements (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id) on delete cascade,
  kind text not null check (kind in ('withdraw', 'deposit', 'reset')),
  amount numeric(12,2) not null check (amount >= 0),
  balance_before numeric(12,2),
  note text,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists cash_movements_store_idx on public.cash_movements (store_id, created_at desc);
alter table public.cash_movements enable row level security;
drop policy if exists cash_movements_admin on public.cash_movements;
create policy cash_movements_admin on public.cash_movements for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Stan gotówki per sklep (tylko administrator).
create or replace function public.cash_balances()
returns table (store_id uuid, sales numeric, returns numeric, deposited numeric, withdrawn numeric, balance numeric,
               last_out_at timestamptz, sales_since numeric, orders_since int)
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_admin() then raise exception 'Tylko administrator'; end if;
  return query
  with s as (select st.id from public.stores st),
  sal as (
    select o.store_id, sum(o.total) as total from public.pos_orders o where o.payment_method = 'cash' group by o.store_id
  ),
  ret as (
    -- Zwrot sztuki ze sprzedaży gotówką = pieniądze wydane z kasy.
    select o.store_id, sum(i.price * coalesce(i.quantity, 1)) as total
    from public.pos_order_items i join public.pos_orders o on o.id = i.order_id
    where o.payment_method = 'cash' and i.status = 'returned' group by o.store_id
  ),
  mv as (
    select m.store_id,
      sum(case when m.kind = 'deposit' then m.amount else 0 end) as dep,
      sum(case when m.kind in ('withdraw', 'reset') then m.amount else 0 end) as wd,
      max(case when m.kind in ('withdraw', 'reset') then m.created_at end) as last_out
    from public.cash_movements m group by m.store_id
  )
  select s.id,
    coalesce(sal.total, 0), coalesce(ret.total, 0), coalesce(mv.dep, 0), coalesce(mv.wd, 0),
    round(coalesce(sal.total, 0) - coalesce(ret.total, 0) + coalesce(mv.dep, 0) - coalesce(mv.wd, 0), 2),
    mv.last_out,
    coalesce((select sum(o.total) from public.pos_orders o where o.store_id = s.id and o.payment_method = 'cash' and (mv.last_out is null or o.created_at > mv.last_out)), 0),
    coalesce((select count(*)::int from public.pos_orders o where o.store_id = s.id and o.payment_method = 'cash' and (mv.last_out is null or o.created_at > mv.last_out)), 0)
  from s left join sal on sal.store_id = s.id left join ret on ret.store_id = s.id left join mv on mv.store_id = s.id;
end $$;
revoke all on function public.cash_balances() from public, anon;
grant execute on function public.cash_balances() to authenticated;

notify pgrst, 'reload schema';
