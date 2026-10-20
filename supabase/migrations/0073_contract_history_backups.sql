-- 0073: historia umów (każda zmiana i usunięcie – zostaje także po usunięciu umowy) oraz miejsce na kopie zapasowe.
-- Można uruchomić kilka razy.

create table if not exists public.contract_events (
  id bigserial primary key,
  contract_id uuid not null,              -- bez klucza obcego: historia zostaje po usunięciu umowy
  label text,                             -- NR / numer dokumentu i kontrahent z chwili zdarzenia
  kind text not null check (kind in ('created', 'updated', 'deleted')),
  changes jsonb not null default '{}'::jsonb,
  actor uuid,
  created_at timestamptz not null default now()
);
create index if not exists contract_events_contract_idx on public.contract_events (contract_id, created_at desc);
create index if not exists contract_events_created_idx on public.contract_events (created_at desc);
alter table public.contract_events enable row level security;
drop policy if exists contract_events_staff on public.contract_events;
create policy contract_events_staff on public.contract_events for select to authenticated using (public.is_staff());

create or replace function public.log_contract_event() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  f text;
  ch jsonb := '{}'::jsonb;
  o jsonb;
  n jsonb;
  -- Śledzone pola (bez podpisu – duży obraz, i tokenu linku).
  fields text[] := array['status','type','counterparty','seller_name','seller_id_number','seller_address','seller_email','seller_phone',
    'seller_bank_account','payment_method','payment_days','amount','amount_per_item','currency','doc_number','vat_form','contract_date',
    'file_path','file_name','items','notes','paid_at','signed_at','accepted_at','units_created_at','sign_expires_at','group_id',
    'consignor_id','location_id','sale_id','offer'];
  rec public.contracts%rowtype;
begin
  rec := coalesce(new, old);
  if tg_op = 'UPDATE' then
    o := to_jsonb(old); n := to_jsonb(new);
    foreach f in array fields loop
      if (o -> f) is distinct from (n -> f) then ch := ch || jsonb_build_object(f, jsonb_build_array(o -> f, n -> f)); end if;
    end loop;
    if ch = '{}'::jsonb then return null; end if;
  elsif tg_op = 'INSERT' then
    n := to_jsonb(new);
    foreach f in array fields loop
      if n ? f and (n -> f) is not null and (n -> f) <> 'null'::jsonb then ch := ch || jsonb_build_object(f, n -> f); end if;
    end loop;
  else
    o := to_jsonb(old) - 'seller_signature' - 'sign_token';
    ch := o;
  end if;
  insert into public.contract_events (contract_id, label, kind, changes, actor)
  values (rec.id,
          concat_ws(' · ', coalesce(rec.doc_number, case when rec.number is not null then 'NR' || rec.number end), coalesce(rec.seller_name, rec.counterparty)),
          case tg_op when 'INSERT' then 'created' when 'UPDATE' then 'updated' else 'deleted' end,
          ch, auth.uid());
  return null;
end $$;
revoke all on function public.log_contract_event() from public, anon, authenticated;

drop trigger if exists contracts_history on public.contracts;
create trigger contracts_history after insert or update or delete on public.contracts
  for each row execute function public.log_contract_event();

-- Kopie zapasowe (prywatne – tylko serwer aplikacji).
insert into storage.buckets (id, name, public) values ('backups', 'backups', false) on conflict (id) do nothing;

-- Codzienna kopia o 3:15 (UTC) – ten sam adres i nagłówek co istniejące zadanie /api/cron/sync (bez wpisywania sekretu).
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    if not exists (select 1 from cron.job where jobname = 'magazyn-backup')
       and exists (select 1 from cron.job where command like '%/api/cron/sync%') then
      perform cron.schedule('magazyn-backup', '15 3 * * *',
        (select replace(command, '/api/cron/sync', '/api/cron/backup') from cron.job where command like '%/api/cron/sync%' order by jobid limit 1));
    end if;
  end if;
end $$;

notify pgrst, 'reload schema';
