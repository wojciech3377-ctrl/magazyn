-- Umowy z szablonu z podpisem zdalnym (link dla sprzedającego).
-- Wklej całość w Supabase → SQL Editor → Run.

create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;
drop policy if exists app_settings_read on public.app_settings;
create policy app_settings_read on public.app_settings for select to authenticated using (public.is_staff());
drop policy if exists app_settings_admin on public.app_settings;
create policy app_settings_admin on public.app_settings for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

insert into public.app_settings (key, value) values
  ('company', jsonb_build_object(
     'name', 'SNEAKERS DEPOT SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ',
     'street', 'Długa 13',
     'city', '61-850 Poznań',
     'nip', '6060120685',
     'email', 'sneakersdepot.pl@gmail.com',
     'payment_days', 7))
on conflict (key) do nothing;

-- Ogólny link do umowy (klient sam wpisuje, co sprzedaje). Klucz w adresie chroni przed przypadkowymi wpisami.
insert into public.app_settings (key, value) values
  ('general_contract_link', jsonb_build_object('key', replace(gen_random_uuid()::text, '-', ''), 'enabled', true))
on conflict (key) do nothing;

create sequence if not exists public.contract_number_seq start 1;

alter table public.contracts
  add column if not exists number bigint unique default nextval('public.contract_number_seq'),
  add column if not exists template text,                       -- np. purchase_v1; null = wgrany skan
  add column if not exists status text not null default 'signed',
  add column if not exists seller_name text,
  add column if not exists seller_id_number text,               -- PESEL albo numer dowodu
  add column if not exists seller_address text,
  add column if not exists seller_email text,
  add column if not exists seller_phone text,
  add column if not exists seller_bank_account text,
  add column if not exists payment_days int,
  add column if not exists items jsonb,                         -- pozycje umowy w chwili wystawienia
  add column if not exists sign_token text unique,
  add column if not exists sign_expires_at timestamptz,
  add column if not exists signed_at timestamptz,
  add column if not exists signer_ip text,
  add column if not exists signer_user_agent text,
  add column if not exists seller_signature text,               -- podpis sprzedającego (PNG, data URL)
  add column if not exists source text,                         -- link (z aplikacji) | general (ogólny link) | upload
  add column if not exists units_created_at timestamptz;

alter table public.contracts drop constraint if exists contracts_status_check;
alter table public.contracts add constraint contracts_status_check check (status in ('sent', 'signed', 'cancelled'));

-- Umowa może dotyczyć sztuk już na stanie albo towaru, który dopiero przyjdzie (np. pod zamówienie).
alter table public.contracts
  add column if not exists sale_id uuid references public.sales (id) on delete set null,
  add column if not exists location_id uuid references public.locations (id);

-- Po podpisie: sztuki „w drodze” dla pozycji bez sztuki; gdy umowa jest pod zamówienie,
-- sztuka od razu przypina się do tego zamówienia.
-- items: [{"unit_id": "...", "variant_id": "...", "title": "...", "option": "...", "identifier": "...", "price": 900, "qty": 1}]
create or replace function public.finalize_contract(p_contract_id uuid)
returns jsonb
language plpgsql
as $$
declare
  c public.contracts%rowtype;
  it jsonb;
  i int;
  v_unit uuid;
  v_created int := 0;
  v_first uuid;
begin
  select * into c from public.contracts where id = p_contract_id for update;
  if not found then raise exception 'Nie ma takiej umowy'; end if;
  if c.units_created_at is not null then raise exception 'Sztuki z tej umowy zostały już utworzone'; end if;
  if exists (select 1 from jsonb_array_elements(coalesce(c.items, '[]'::jsonb)) e
             where nullif(e ->> 'unit_id', '') is null and nullif(e ->> 'variant_id', '') is null) then
    raise exception 'Przypisz produkt z katalogu do każdej pozycji umowy';
  end if;

  for it in select * from jsonb_array_elements(coalesce(c.items, '[]'::jsonb)) loop
    if it ? 'unit_id' and nullif(it ->> 'unit_id', '') is not null then
      update public.units
      set contract_id = c.id,
          purchase_price = coalesce((it ->> 'price')::numeric, purchase_price)
      where id = (it ->> 'unit_id')::uuid;
      insert into public.unit_events (unit_id, type, data)
      values ((it ->> 'unit_id')::uuid, 'contract', jsonb_build_object('contract_id', c.id, 'signed', true));
    else
      if c.location_id is null then raise exception 'Umowa nie ma lokalizacji dla nowych sztuk'; end if;
      for i in 1..greatest(coalesce((it ->> 'qty')::int, 1), 1) loop
        insert into public.units (variant_id, location_id, status, owner_type, purchase_form, purchase_price, contract_id, notes)
        values ((it ->> 'variant_id')::uuid, c.location_id, 'in_transit', 'own', 'vat_margin',
                (it ->> 'price')::numeric, c.id, 'z umowy ' || coalesce(c.number::text, ''))
        returning id into v_unit;
        insert into public.unit_events (unit_id, type, data)
        values (v_unit, 'received', jsonb_build_object('status', 'in_transit', 'contract_id', c.id, 'sale_id', c.sale_id));
        v_created := v_created + 1;
        if v_first is null then v_first := v_unit; end if;
      end loop;
    end if;
  end loop;

  -- Pod zamówienie: pierwsza nowa sztuka obsługuje sprzedaż bez sztuki.
  if c.sale_id is not null and v_first is not null then
    update public.sales set unit_id = v_first, status = 'assigned'
    where id = c.sale_id and unit_id is null;
  end if;

  update public.contracts set units_created_at = now() where id = c.id;
  return jsonb_build_object('created_units', v_created);
end;
$$;

-- Przyjęcie towaru „w drodze”: sztuka przypięta do zamówienia od razu staje się sprzedana,
-- pozostałe wchodzą na stan. Zwraca sztuki, które weszły na stan (do podniesienia stanu w Base).
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
    update public.units
    set status = case when v_sold then 'sold' else 'in_stock' end,
        sold_at = case when v_sold then now() else null end,
        received_at = now()
    where id = u.id;
    insert into public.unit_events (unit_id, type, data)
    values (u.id, 'status', jsonb_build_object('from', 'in_transit', 'to', case when v_sold then 'sold' else 'in_stock' end, 'for_order', v_sold));
    unit_id := u.id; variant_id := u.variant_id; location_id := u.location_id;
    to_status := case when v_sold then 'sold' else 'in_stock' end;
    return next;
  end loop;
end;
$$;
