-- 1) Ceny promocyjne i historia cen (metka sklepowa: cena przed obniżką, najniższa cena z 30 dni).
-- 2) Oferty cenowe do umów (Tak / Nie / Oferta) i faktury komisantów do zatwierdzenia.
-- 3) Zgłoszenia rzeczy od komisantów (komisant → propozycja → akceptacja → paczka z trackingiem → przyjęcie).

-- ───────── 1. Ceny ─────────
alter table public.variant_store_links add column if not exists compare_at_price numeric(12,2);

create table if not exists public.variant_price_history (
  id bigserial primary key,
  variant_id uuid not null references public.variants (id) on delete cascade,
  store_id uuid not null references public.stores (id) on delete cascade,
  price numeric(12,2) not null,
  compare_at_price numeric(12,2),
  valid_from timestamptz not null default now()
);
create index if not exists variant_price_history_idx on public.variant_price_history (variant_id, store_id, valid_from desc);
alter table public.variant_price_history enable row level security;
drop policy if exists variant_price_history_read on public.variant_price_history;
create policy variant_price_history_read on public.variant_price_history for select to authenticated using (public.is_staff());

create or replace function public.log_variant_price()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.price is null then return new; end if;
  if tg_op = 'INSERT' or new.price is distinct from old.price or new.compare_at_price is distinct from old.compare_at_price then
    insert into public.variant_price_history (variant_id, store_id, price, compare_at_price)
    values (new.variant_id, new.store_id, new.price, new.compare_at_price);
  end if;
  return new;
end;
$$;
drop trigger if exists variant_price_log on public.variant_store_links;
create trigger variant_price_log after insert or update of price, compare_at_price on public.variant_store_links
  for each row execute function public.log_variant_price();

-- Punkt startowy historii: obecne ceny.
insert into public.variant_price_history (variant_id, store_id, price, compare_at_price)
select distinct on (variant_id, store_id) variant_id, store_id, price, compare_at_price
from public.variant_store_links
where price is not null and not exists (select 1 from public.variant_price_history h where h.variant_id = variant_store_links.variant_id and h.store_id = variant_store_links.store_id)
order by variant_id, store_id, updated_at desc;

-- Ponowny odczyt katalogu ze Shopify (porcjami w automacie), żeby uzupełnić ceny przed obniżką.
delete from public.sync_state where key like 'shopify_products:%';

-- ───────── 2. Umowy: oferta cenowa, faktury komisantów ─────────
alter table public.contracts drop constraint if exists contracts_status_check;
alter table public.contracts add constraint contracts_status_check
  check (status in ('sent', 'signed', 'offer', 'accepted', 'rejected', 'cancelled'));
alter table public.contracts add column if not exists offer jsonb;               -- {prices:[...], note, sent_at, location_id, previous:[...]}
alter table public.contracts add column if not exists offer_responded_at timestamptz;

-- Zakładki w Umowach: podpisane / faktury komisantów / oferty czekają na decyzję.
create or replace view public.contract_overview with (security_invoker = true) as
select
  c.id, c.number, c.type, c.counterparty, c.contract_date, c.amount, c.currency, c.file_path, c.created_at,
  c.status, c.source, c.template, c.units_created_at, c.paid_at, c.payment_method,
  count(u.id) as units_total,
  count(u.id) filter (where u.status = 'in_transit') as units_in_transit,
  case
    when c.status in ('rejected', 'cancelled') then 'rejected'
    when c.status in ('sent', 'signed', 'offer') then 'pending'
    when c.paid_at is not null or c.template is null or c.source = 'consignor' then 'done'
    when count(u.id) filter (where u.status = 'in_transit') > 0 then 'in_transit'
    else 'to_pay'
  end as category,
  c.items
from public.contracts c
left join public.units u on u.contract_id = c.id
group by c.id;

-- Niewykorzystane umowy z tekstem pozycji (wyszukiwanie po produkcie).
create or replace view public.contract_overview_unused
with (security_invoker = true) as
select o.*,
  (select string_agg(coalesce(e ->> 'title', '') || ' ' || coalesce(e ->> 'option', ''), ', ') from jsonb_array_elements(coalesce(o.items, '[]'::jsonb)) e) as items_text
from public.contract_overview o where o.id in (select id from public.contracts_unused);
grant select on public.contract_overview_unused to authenticated;

-- ───────── 3. Zgłoszenia od komisantów ─────────
alter table public.locations add column if not exists ship_address text;   -- adres do wysyłki do nas (pokazywany komisantom)

create table if not exists public.consignor_intakes (
  id uuid primary key default gen_random_uuid(),
  consignor_id uuid not null references public.consignors (id) on delete cascade,
  location_id uuid not null references public.locations (id),
  status text not null default 'review' check (status in ('review', 'offer', 'to_send', 'sent', 'received', 'closed', 'cancelled')),
  note text,
  tracking text,
  carrier text,
  delivery_id uuid references public.deliveries (id) on delete set null,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  sent_at timestamptz,
  received_at timestamptz,
  received_by uuid
);
create index if not exists consignor_intakes_idx on public.consignor_intakes (consignor_id, created_at desc);
create index if not exists consignor_intakes_status_idx on public.consignor_intakes (status);

create table if not exists public.consignor_intake_items (
  id uuid primary key default gen_random_uuid(),
  intake_id uuid not null references public.consignor_intakes (id) on delete cascade,
  position int not null default 0,
  variant_id uuid references public.variants (id),
  title text not null,
  option text,
  proposed_price numeric(12,2) not null check (proposed_price > 0),
  offer_price numeric(12,2),
  final_price numeric(12,2),
  status text not null default 'proposed' check (status in ('proposed', 'offered', 'accepted', 'rejected', 'declined', 'received', 'missing')),
  unit_id uuid references public.units (id) on delete set null
);
create index if not exists consignor_intake_items_idx on public.consignor_intake_items (intake_id, position);

alter table public.consignor_intakes enable row level security;
alter table public.consignor_intake_items enable row level security;
drop policy if exists consignor_intakes_staff on public.consignor_intakes;
create policy consignor_intakes_staff on public.consignor_intakes for all to authenticated using (public.is_staff()) with check (public.is_staff());
drop policy if exists consignor_intake_items_staff on public.consignor_intake_items;
create policy consignor_intake_items_staff on public.consignor_intake_items for all to authenticated using (public.is_staff()) with check (public.is_staff());

notify pgrst, 'reload schema';
