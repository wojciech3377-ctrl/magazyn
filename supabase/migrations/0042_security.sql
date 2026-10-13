-- 0042: zabezpieczenia – limity prób (logowanie, linki publiczne, drukarka), dziennik zdarzeń bezpieczeństwa,
-- dodatkowe sprawdzenie uprawnień w funkcji settle_order_units i odebranie zbędnych uprawnień do funkcji.

-- 1. Limity prób: licznik w oknie czasowym na klucz (np. „login:ip:1.2.3.4”, „login:email:jan@…”).
create table if not exists public.rate_limits (
  key text primary key,
  window_start timestamptz not null default now(),
  hits int not null default 0
);
alter table public.rate_limits enable row level security;
-- Brak polityk: tabela dostępna tylko dla serwera (service_role).
revoke all on public.rate_limits from anon, authenticated;
grant all on public.rate_limits to service_role;

create or replace function public.rate_limit_hit(p_key text, p_max int, p_window_seconds int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hits int;
begin
  insert into public.rate_limits as r (key, window_start, hits)
  values (left(p_key, 200), now(), 1)
  on conflict (key) do update
    set hits = case when r.window_start < now() - make_interval(secs => p_window_seconds) then 1 else r.hits + 1 end,
        window_start = case when r.window_start < now() - make_interval(secs => p_window_seconds) then now() else r.window_start end
  returning hits into v_hits;
  -- Sprzątanie starych wpisów (rzadko, przy okazji).
  if random() < 0.02 then
    delete from public.rate_limits where window_start < now() - interval '1 day';
  end if;
  return v_hits <= p_max;
end;
$$;
revoke all on function public.rate_limit_hit(text, int, int) from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, int, int) to service_role;

-- Zerowanie licznika (np. po udanym logowaniu).
create or replace function public.rate_limit_reset(p_key text)
returns void
language sql
security definer
set search_path = public
as $$ delete from public.rate_limits where key = left(p_key, 200); $$;
revoke all on function public.rate_limit_reset(text) from public, anon, authenticated;
grant execute on function public.rate_limit_reset(text) to service_role;

-- 2. Dziennik zdarzeń bezpieczeństwa (nieudane logowania, blokady, złe klucze drukarki). Czyta administrator.
create table if not exists public.security_events (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  kind text not null,
  subject text,
  ip text,
  user_agent text,
  detail jsonb
);
create index if not exists security_events_at_idx on public.security_events (at desc);
alter table public.security_events enable row level security;
drop policy if exists security_events_admin_read on public.security_events;
create policy security_events_admin_read on public.security_events for select to authenticated using (public.is_admin());
revoke insert, update, delete on public.security_events from anon, authenticated;
grant select on public.security_events to authenticated;
grant all on public.security_events to service_role;

-- 3. settle_order_units: wywołanie przez zalogowaną osobę tylko dla pracownika (komisant nie).
create or replace function public.settle_order_units()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  n int;
begin
  if auth.uid() is not null and not public.is_staff() then
    raise exception 'Brak uprawnień';
  end if;
  with done as (
    select distinct s.unit_id, s.id as sale_id, o.name, o.ordered_at
    from public.sales s
    join public.orders o on o.id = s.order_id
    join public.units u on u.id = s.unit_id
    where s.status = 'assigned' and u.status = 'reserved'
      and (o.receipt_id is not null
           or exists (select 1 from public.receipts r where r.order_id = o.id)
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
$function$;
revoke all on function public.settle_order_units() from public, anon;
grant execute on function public.settle_order_units() to authenticated, service_role;

-- 4. Funkcje wyzwalaczy nie są do wywoływania przez API.
do $$
begin
  if exists (select 1 from pg_proc where proname = 'handle_new_user' and pronamespace = 'public'::regnamespace) then
    execute 'revoke all on function public.handle_new_user() from public, anon, authenticated';
  end if;
  if exists (select 1 from pg_proc where proname = 'log_variant_price' and pronamespace = 'public'::regnamespace) then
    execute 'revoke all on function public.log_variant_price() from public, anon, authenticated';
  end if;
end $$;

-- 5. Nowe funkcje w schemacie public domyślnie bez prawa wywołania dla anon (Supabase domyślnie je nadaje).
alter default privileges in schema public revoke execute on functions from anon;

notify pgrst, 'reload schema';
