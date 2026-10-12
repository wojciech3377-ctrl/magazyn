-- 0040: (1) Do zrobienia – zadania dla pracowników (bez przypisanych osób – dla wszystkich).
--       (2) Osobna umowa dla każdej rzeczy: umowa z kilkoma rzeczami po zatwierdzeniu dzieli się na umowy
--           po jednej rzeczy, każda z własnym numerem (wspólne group_id = pierwotna umowa).
create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(trim(title)) > 0),
  notes text,
  assignees uuid[] not null default '{}',          -- pusto = wszyscy pracownicy
  due_date date,
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high')),
  done_at timestamptz,
  done_by uuid references public.profiles (id) on delete set null,
  created_by uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists tasks_open_idx on public.tasks (done_at, due_date);
create index if not exists tasks_assignees_idx on public.tasks using gin (assignees);
alter table public.tasks enable row level security;
drop policy if exists tasks_staff on public.tasks;
create policy tasks_staff on public.tasks for all to authenticated using (public.is_staff()) with check (public.is_staff());

alter table public.contracts add column if not exists group_id uuid references public.contracts (id) on delete set null;
create index if not exists contracts_group_idx on public.contracts (group_id) where group_id is not null;

/*
 * Dzieli umowę (szablon, zatwierdzaną) na osobne umowy – po jednej rzeczy (pozycja z ilością 3 = 3 umowy).
 * Pierwsza rzecz zostaje w tej umowie, kolejne dostają nowe umowy z kolejnymi numerami i tymi samymi danymi
 * sprzedającego i podpisem. Zwraca identyfikatory wszystkich umów z grupy.
 */
create or replace function public.split_contract(p_contract_id uuid)
returns uuid[]
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.contracts%rowtype;
  it jsonb;
  pieces jsonb := '[]'::jsonb;
  piece jsonb;
  k int;
  n int;
  v_new uuid;
  ids uuid[];
begin
  if not public.is_staff() and auth.uid() is not null then raise exception 'Brak uprawnień'; end if;
  select * into c from public.contracts where id = p_contract_id for update;
  if not found then raise exception 'Nie ma takiej umowy'; end if;
  if c.template is null or c.units_created_at is not null then return array[c.id]; end if;
  for it in select * from jsonb_array_elements(coalesce(c.items, '[]'::jsonb)) loop
    for k in 1..greatest(coalesce((it ->> 'qty')::int, 1), 1) loop
      pieces := pieces || jsonb_build_array(jsonb_set(it, '{qty}', '1'::jsonb));
    end loop;
  end loop;
  n := jsonb_array_length(pieces);
  if n <= 1 then return array[c.id]; end if;

  ids := array[c.id];
  update public.contracts
  set items = jsonb_build_array(pieces -> 0),
      amount = coalesce((pieces -> 0 ->> 'price')::numeric, amount),
      group_id = c.id
  where id = c.id;
  for k in 1..n - 1 loop
    piece := pieces -> k;
    insert into public.contracts (
      type, counterparty, consignor_id, contract_date, amount, notes, created_by, template, status,
      seller_name, seller_id_number, seller_address, seller_email, seller_phone, seller_bank_account, payment_days,
      items, sign_token, sign_expires_at, signed_at, signer_ip, signer_user_agent, seller_signature, source,
      location_id, payment_method, currency, seller_country, language, accepted_at, accepted_by, group_id
    ) values (
      c.type, c.counterparty, c.consignor_id, c.contract_date, (piece ->> 'price')::numeric,
      trim(both ' ' from coalesce(c.notes, '') || ' (z umowy nr ' || coalesce(c.number::text, '') || ')'),
      c.created_by, c.template, c.status,
      c.seller_name, c.seller_id_number, c.seller_address, c.seller_email, c.seller_phone, c.seller_bank_account, c.payment_days,
      jsonb_build_array(piece), md5(random()::text || clock_timestamp()::text) || md5(random()::text || c.id::text), c.sign_expires_at, c.signed_at,
      c.signer_ip, c.signer_user_agent, c.seller_signature, c.source,
      c.location_id, c.payment_method, c.currency, c.seller_country, c.language, c.accepted_at, c.accepted_by, c.id
    ) returning id into v_new;
    -- Rzecz z magazynu wskazana w umowie dostaje nową umowę.
    if nullif(piece ->> 'unit_id', '') is not null then
      update public.units set contract_id = v_new where id = (piece ->> 'unit_id')::uuid and contract_id = c.id;
    end if;
    ids := ids || v_new;
  end loop;
  return ids;
end;
$$;
revoke all on function public.split_contract(uuid) from public, anon;
grant execute on function public.split_contract(uuid) to authenticated;

notify pgrst, 'reload schema';
