-- 0077: Bezpieczeństwo bazy.
-- 1. Baza odpowiada pracownikom tylko przez serwer aplikacji. Wcześniej pracownik mógł wziąć swój token logowania
--    z przeglądarki i pytać bazę bezpośrednio (z pominięciem aplikacji): ceny zakupu, PESEL, konta, usuwanie umów.
--    Teraz is_staff() / is_admin() wymagają nagłówka, który zna tylko serwer (wyliczony z klucza serwera).
--    Skrót tego nagłówka serwer sam zapisuje w server_keys przy pierwszym zapytaniu – nic nie trzeba wpisywać.
--    Awaryjnie (gdyby coś przestało działać): delete from public.server_keys;  → baza działa jak przed 0077.
-- 2. Pliki umów w Storage tylko przez serwer (pracownik nie pobierze listy ani plików bezpośrednio).
-- 3. Rola anon (bez logowania) bez dostępu do tabel i funkcji; funkcje SECURITY DEFINER – tylko te, które
--    aplikacja wywołuje w imieniu pracownika (reszta tylko serwer).
-- 4. Podpis sprzedającego (obrazek, data, IP) może ustawić tylko formularz podpisu – nie pracownik.
-- 5. Tokeny umów po podziale – losowe kryptograficznie (zamiast random()).
-- Można uruchomić kilka razy.

-- ───────── 1. Klucz serwera ─────────
create table if not exists public.server_keys (
  id int primary key default 1 check (id = 1),
  key_hash text not null,
  updated_at timestamptz not null default now()
);
alter table public.server_keys enable row level security;
revoke all on public.server_keys from public, anon, authenticated;

create or replace function public.request_from_server() returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  v_cached text;
  v_hash text;
  v_hdr text;
  v_role text;
  v_ok boolean;
begin
  -- Serwer z kluczem service_role (zadania cykliczne, webhooki) – zawsze.
  begin
    v_role := coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role', current_setting('role', true));
  exception when others then v_role := null;
  end;
  if v_role = 'service_role' then return true; end if;
  -- Wynik zapamiętany na czas jednego zapytania (transakcji).
  v_cached := current_setting('magazyn.server_ok', true);
  if v_cached = '1' then return true; elsif v_cached = '0' then return false; end if;
  select key_hash into v_hash from public.server_keys where id = 1;
  if v_hash is null then
    v_ok := true; -- serwer jeszcze nie zapisał klucza – jak przed 0077
  else
    begin
      v_hdr := nullif(current_setting('request.headers', true), '')::json ->> 'x-magazyn-server';
    exception when others then v_hdr := null;
    end;
    v_ok := v_hdr is not null and encode(sha256(convert_to(v_hdr, 'UTF8')), 'hex') = v_hash;
  end if;
  perform set_config('magazyn.server_ok', case when v_ok then '1' else '0' end, true);
  return v_ok;
end $$;

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select public.request_from_server() and exists (select 1 from public.profiles where id = auth.uid() and active);
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select public.request_from_server() and exists (select 1 from public.profiles where id = auth.uid() and active and role = 'admin');
$$;

-- ───────── 2. Pliki umów: tylko serwer (podpisane linki tworzy serwer po sprawdzeniu uprawnień) ─────────
drop policy if exists contracts_files_read on storage.objects;
drop policy if exists contracts_files_insert on storage.objects;
drop policy if exists contracts_files_delete on storage.objects;

-- ───────── 3. Uprawnienia ról ─────────
-- anon: bez tabel, widoków i sekwencji (publiczne strony korzystają z serwera).
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

do $$
declare
  f record;
  had boolean;
  -- Funkcje z uprawnieniami właściciela, które aplikacja wywołuje w imieniu pracownika (same sprawdzają uprawnienia).
  allow text[] := array['is_staff', 'is_admin', 'request_from_server', 'settle_order_units', 'assign_unit_variant',
                        'create_unassigned_variant', 'create_line_unit', 'cash_balances', 'purge_non_shopify'];
begin
  for f in
    select p.oid::regprocedure as sig, p.proname, p.prosecdef
    from pg_proc p
    left join pg_depend d on d.objid = p.oid and d.deptype = 'e'
    where p.pronamespace = 'public'::regnamespace and d.objid is null and p.prokind = 'f'
  loop
    -- Funkcje bez uprawnień właściciela: pracownik zachowuje to, co miał (także przez PUBLIC).
    had := has_function_privilege('authenticated', f.sig, 'execute');
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
    if (not f.prosecdef and had) or f.proname = any (allow) then
      execute format('grant execute on function %s to authenticated', f.sig);
    else
      execute format('revoke all on function %s from authenticated', f.sig);
    end if;
  end loop;
end $$;

-- Nowe obiekty w przyszłości: bez anon (każda migracja nadaje uprawnienia jawnie).
do $$ begin
  alter default privileges in schema public revoke all on tables from anon;
  alter default privileges in schema public revoke all on sequences from anon;
  alter default privileges in schema public revoke execute on functions from public, anon;
  alter default privileges in schema public grant execute on functions to authenticated, service_role;
exception when others then raise notice 'Domyślne uprawnienia: %', sqlerrm;
end $$;

do $$ begin
  alter function public.prune_store_catalog(uuid, timestamptz) set search_path = public, extensions;
exception when undefined_function then null;
end $$;

-- ───────── 4. Dowód podpisu tylko z formularza podpisu ─────────
create or replace function public.contracts_signature_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon') and (
       new.seller_signature is distinct from old.seller_signature
    or new.signed_at is distinct from old.signed_at
    or (to_jsonb(new) ->> 'signer_ip') is distinct from (to_jsonb(old) ->> 'signer_ip')
    or (to_jsonb(new) ->> 'signer_user_agent') is distinct from (to_jsonb(old) ->> 'signer_user_agent')) then
    raise exception 'Podpis sprzedającego (obrazek, data, IP) może ustawić tylko formularz podpisu.';
  end if;
  return new;
end $$;
drop trigger if exists contracts_signature_guard on public.contracts;
create trigger contracts_signature_guard before update on public.contracts
  for each row execute function public.contracts_signature_guard();
revoke all on function public.contracts_signature_guard() from public, anon, authenticated;

-- ───────── 5. Losowe tokeny przy podziale umowy ─────────
do $$
declare f record; def text;
begin
  for f in select p.oid from pg_proc p where p.pronamespace = 'public'::regnamespace
           and pg_get_functiondef(p.oid) like '%md5(random()::text%' loop
    def := pg_get_functiondef(f.oid);
    def := replace(def, 'md5(random()::text || clock_timestamp()::text) || md5(random()::text || c.id::text)',
                   'replace(gen_random_uuid()::text, ''-'', '''') || replace(gen_random_uuid()::text, ''-'', '''')');
    if def not like '%md5(random()::text%' then execute def; end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
