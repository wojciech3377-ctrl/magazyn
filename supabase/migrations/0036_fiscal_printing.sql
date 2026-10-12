-- 0036: własne drukowanie paragonów fiskalnych (zamiast Base). Aplikacja kładzie paragon do kolejki,
-- program na komputerze przy drukarce (Windows) pobiera go, drukuje na drukarce fiskalnej i odsyła numer.

create table if not exists public.fiscal_printers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  location_id uuid references public.locations (id) on delete set null,
  token_hash text not null unique,           -- sha256 klucza programu (sam klucz widać tylko raz, przy dodaniu)
  active boolean not null default true,
  last_seen_at timestamptz,
  last_status jsonb,                         -- ostatni stan zgłoszony przez program (wersja, model, błąd)
  created_at timestamptz not null default now()
);
alter table public.fiscal_printers enable row level security;
drop policy if exists fiscal_printers_read on public.fiscal_printers;
create policy fiscal_printers_read on public.fiscal_printers for select to authenticated using (public.is_staff());

create table if not exists public.receipt_jobs (
  id uuid primary key default gen_random_uuid(),
  number serial,
  source text not null check (source in ('pos', 'order', 'test')),
  pos_order_id uuid references public.pos_orders (id) on delete cascade,
  order_id uuid references public.orders (id) on delete cascade,
  printer_id uuid references public.fiscal_printers (id) on delete set null,
  lines jsonb not null default '[]',         -- [{name, qty, price, ptu}] – cena brutto za sztukę, ptu = litera stawki (A, F…)
  total numeric(12,2) not null default 0,
  payment text not null default 'cash',      -- cash / card / transfer / mobile
  status text not null default 'queued' check (status in ('queued', 'printing', 'printed', 'error', 'cancelled')),
  receipt_number text,
  error text,
  attempts int not null default 0,
  claimed_at timestamptz,
  printed_at timestamptz,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);
create index if not exists receipt_jobs_status_idx on public.receipt_jobs (status, created_at);
create index if not exists receipt_jobs_pos_idx on public.receipt_jobs (pos_order_id);
create index if not exists receipt_jobs_order_idx on public.receipt_jobs (order_id);
-- Jeden paragon do sprzedaży: nowy dopiero, gdy poprzedni się nie udał albo został anulowany.
create unique index if not exists receipt_jobs_pos_uq on public.receipt_jobs (pos_order_id) where pos_order_id is not null and status in ('queued', 'printing', 'printed');
create unique index if not exists receipt_jobs_order_uq on public.receipt_jobs (order_id) where order_id is not null and status in ('queued', 'printing', 'printed');
alter table public.receipt_jobs enable row level security;
drop policy if exists receipt_jobs_read on public.receipt_jobs;
create policy receipt_jobs_read on public.receipt_jobs for select to authenticated using (public.is_staff());

-- Paragon z naszej drukarki do zamówienia ze sklepu (bez Base).
alter table public.receipts add column if not exists order_id uuid references public.orders (id) on delete set null;
alter table public.receipts add column if not exists job_id uuid references public.receipt_jobs (id) on delete set null;
create index if not exists receipts_order_idx on public.receipts (order_id);

/* Program drukarki pobiera najstarszy paragon z kolejki (tylko jeden program dostaje dany paragon). */
create or replace function public.claim_receipt_job(p_printer uuid)
returns setof public.receipt_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  update public.fiscal_printers set last_seen_at = now() where id = p_printer;
  select j.id into v_id from public.receipt_jobs j
  where j.status = 'queued' and (j.printer_id is null or j.printer_id = p_printer)
  order by j.created_at
  limit 1
  for update skip locked;
  if v_id is null then return; end if;
  return query
  update public.receipt_jobs set status = 'printing', printer_id = p_printer, claimed_at = now(), attempts = attempts + 1
  where id = v_id returning *;
end;
$$;
revoke all on function public.claim_receipt_job(uuid) from public, anon, authenticated;

/*
 * Wynik wydruku od programu: wydrukowany (numer paragonu → tabela paragonów, JPK, sztuki zamówienia sprzedane)
 * albo błąd (do ponowienia w aplikacji).
 */
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
        'tax_rate', case when l->>'ptu' = 'A' then 23 else 0 end, 'ptu', l->>'ptu')), '[]'::jsonb) from jsonb_array_elements(j.lines) l),
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

/* Zamówienie z paragonem z naszej drukarki też rozlicza zarezerwowane sztuki (jak paragon z Base i faktura). */
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
$$;
revoke all on function public.settle_order_units() from public, anon;
grant execute on function public.settle_order_units() to authenticated;

notify pgrst, 'reload schema';
