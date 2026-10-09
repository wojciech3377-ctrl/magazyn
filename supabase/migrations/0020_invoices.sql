-- Faktury sprzedaży (FVM/1/2026 …) wysyłane do KSeF.

create table if not exists public.invoice_counters (
  series text not null,
  year int not null,
  last int not null default 0,
  primary key (series, year)
);
alter table public.invoice_counters enable row level security;

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  series text not null default 'FVM',
  year int not null,
  seq int not null,
  number text not null unique,                    -- FVM/1/2026
  issue_date date not null default current_date,
  sale_date date not null default current_date,
  place text,
  seller jsonb not null,                          -- dane sprzedawcy w chwili wystawienia
  buyer jsonb not null,                           -- {name, nip, address1, address2, country, email, company}
  currency text not null default 'PLN',
  payment_method text not null default 'transfer' check (payment_method in ('cash', 'card', 'transfer', 'mobile')),
  paid boolean not null default false,
  paid_at date,
  due_date date,
  total_gross numeric(12,2) not null default 0,
  net_23 numeric(12,2) not null default 0,
  vat_23 numeric(12,2) not null default 0,
  margin_total numeric(12,2) not null default 0,
  notes text,
  order_id uuid references public.orders (id) on delete set null,
  pos_order_id uuid references public.pos_orders (id) on delete set null,
  status text not null default 'issued' check (status in ('issued', 'sending', 'accepted', 'rejected', 'cancelled')),  -- cancelled = odrzucona i zastąpiona nową
  xml text,
  xml_hash text,                                  -- SHA-256 base64 pliku XML (do KSeF i kodu QR)
  ksef_session_ref text,
  ksef_invoice_ref text,
  ksef_number text,
  ksef_status_code int,
  ksef_status text,
  ksef_sent_at timestamptz,
  ksef_accepted_at timestamptz,
  created_by uuid references public.profiles (id) default auth.uid(),
  created_at timestamptz not null default now(),
  unique (series, year, seq)
);
create index if not exists invoices_issue_idx on public.invoices (issue_date desc);
create index if not exists invoices_order_idx on public.invoices (order_id);
create index if not exists invoices_pos_idx on public.invoices (pos_order_id);
create index if not exists invoices_status_idx on public.invoices (status);
-- Jedna ważna faktura na zamówienie / sprzedaż stacjonarną (odrzucone i unieważnione się nie liczą).
create unique index if not exists invoices_order_uq on public.invoices (order_id) where order_id is not null and status not in ('rejected', 'cancelled');
create unique index if not exists invoices_pos_uq on public.invoices (pos_order_id) where pos_order_id is not null and status not in ('rejected', 'cancelled');

create table if not exists public.invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices (id) on delete cascade,
  position int not null,
  name text not null,
  quantity numeric(12,3) not null default 1,
  unit text not null default 'szt.',
  unit_price_gross numeric(12,2) not null,
  total_gross numeric(12,2) not null,
  vat text not null check (vat in ('23', 'margin')),
  unit_id uuid references public.units (id) on delete set null,
  sale_id uuid references public.sales (id) on delete set null,
  pos_item_id uuid references public.pos_order_items (id) on delete set null,
  unique (invoice_id, position)
);
create index if not exists invoice_items_unit_idx on public.invoice_items (unit_id);

alter table public.invoices enable row level security;
alter table public.invoice_items enable row level security;
drop policy if exists invoices_read on public.invoices;
create policy invoices_read on public.invoices for select to authenticated using (public.is_staff());
drop policy if exists invoice_items_read on public.invoice_items;
create policy invoice_items_read on public.invoice_items for select to authenticated using (public.is_staff());

-- Kolejny numer w serii i roku (atomowo; numeracja bez dziur liczy się od 1 w każdym roku).
create or replace function public.next_invoice_seq(p_series text, p_year int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v int;
begin
  insert into public.invoice_counters (series, year, last) values (p_series, p_year, 1)
  on conflict (series, year) do update set last = public.invoice_counters.last + 1
  returning last into v;
  return v;
end;
$$;
revoke all on function public.next_invoice_seq(text, int) from public, anon, authenticated;

-- Faktura z pozycjami w jednej transakcji (numer bez dziur). Wołane tylko przez serwer.
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
  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then
    raise exception 'Faktura musi mieć co najmniej jedną pozycję';
  end if;
  v_seq := public.next_invoice_seq(v_series, v_year);
  v_number := v_series || '/' || v_seq || '/' || v_year;
  insert into public.invoices (series, year, seq, number, issue_date, sale_date, place, seller, buyer, currency, payment_method, paid, paid_at,
    due_date, total_gross, net_23, vat_23, margin_total, notes, order_id, pos_order_id, created_by)
  values (v_series, v_year, v_seq, v_number,
    coalesce((p_invoice->>'issue_date')::date, current_date), coalesce((p_invoice->>'sale_date')::date, current_date),
    p_invoice->>'place', p_invoice->'seller', p_invoice->'buyer', coalesce(p_invoice->>'currency', 'PLN'),
    coalesce(p_invoice->>'payment_method', 'transfer'), coalesce((p_invoice->>'paid')::boolean, false), (p_invoice->>'paid_at')::date,
    (p_invoice->>'due_date')::date, (p_invoice->>'total_gross')::numeric, (p_invoice->>'net_23')::numeric, (p_invoice->>'vat_23')::numeric,
    (p_invoice->>'margin_total')::numeric, p_invoice->>'notes', (p_invoice->>'order_id')::uuid, (p_invoice->>'pos_order_id')::uuid,
    (p_invoice->>'created_by')::uuid)
  returning invoices.id into v_id;
  insert into public.invoice_items (invoice_id, position, name, quantity, unit, unit_price_gross, total_gross, vat, unit_id, sale_id, pos_item_id)
  select v_id, e.ord::int, e.i->>'name', coalesce((e.i->>'quantity')::numeric, 1), coalesce(e.i->>'unit', 'szt.'),
    (e.i->>'unit_price_gross')::numeric, (e.i->>'total_gross')::numeric, e.i->>'vat', (e.i->>'unit_id')::uuid, (e.i->>'sale_id')::uuid, (e.i->>'pos_item_id')::uuid
  from jsonb_array_elements(p_items) with ordinality as e(i, ord);
  return query select v_id, v_number;
end;
$$;
revoke all on function public.create_invoice(jsonb, jsonb) from public, anon, authenticated;
