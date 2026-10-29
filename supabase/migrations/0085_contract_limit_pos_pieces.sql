-- 0085:
-- 1) Ile rzeczy obejmuje umowa (np. faktura na 2 pary z „kwotą za każdą rzecz”). Gdy na umowie jest już tyle
--    rzeczy – nie da się przypiąć kolejnej (umowa znika z list wyboru). Puste = jak dotąd.
-- 2) Sprzedaż w Kasie: pozycja z ilością > 1 (np. 2 × Sling Bag) – każda sztuka osobno, żeby do każdej dało się
--    dołączyć osobną umowę. Suma sprzedaży i wydrukowane paragony bez zmian (paragon ma własny zapis pozycji).
--    Faktur nie dzielimy (wystawiony dokument się nie zmienia).
-- 3) JPK: „nie dotyczy” przy pozycji bez umowy (np. sznurówki, własny towar) – pozycja zostaje w JPK i w Excelu.
-- Można uruchomić kilka razy.

-- ───────── 1. Limit rzeczy na umowie ─────────
alter table public.contracts add column if not exists item_limit integer;
do $$ begin
  alter table public.contracts add constraint contracts_item_limit_chk check (item_limit is null or item_limit between 1 and 10000);
exception when duplicate_object then null;
end $$;

-- ───────── 2. Pozycje Kasy – po jednej sztuce ─────────
create or replace function public.split_pos_item(p_item uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare
  r public.pos_order_items%rowtype;
  n integer;
begin
  select * into r from public.pos_order_items where id = p_item for update;
  if not found then return 0; end if;
  -- Tylko całkowite ilości (np. 2 szt.); ilości ułamkowe (waga) zostają jedną pozycją.
  if r.quantity is null or r.quantity <= 1 or r.quantity <> trunc(r.quantity) or r.quantity > 500 then return 0; end if;
  n := r.quantity::integer;
  update public.pos_order_items set quantity = 1 where id = p_item;
  insert into public.pos_order_items (order_id, unit_id, price, status, name, ptu, quantity, product_id)
  select r.order_id, null, r.price, r.status,
         -- Pozycja ze sztuką z magazynu ma nazwę z produktu – kopie (bez sztuki) dostają ją wprost.
         coalesce(nullif(trim(r.name), ''), (select p.title || ' ' || v.option from public.units u join public.variants v on v.id = u.variant_id
                                              join public.products p on p.id = v.product_id where u.id = r.unit_id), 'Towar'),
         coalesce(r.ptu, (select case when u.purchase_form = 'vat_23' then 'A' else 'F' end from public.units u where u.id = r.unit_id), 'F'),
         1, r.product_id
    from generate_series(2, n);
  return n - 1;
end $$;
revoke all on function public.split_pos_item(uuid) from public, anon, authenticated;
grant execute on function public.split_pos_item(uuid) to service_role;

-- „Dołącz umowę” do pozycji bez sztuki: najpierw podział na sztuki (pierwsza dostaje sztukę, reszta – osobne pozycje).
create or replace function public.create_line_unit(p_kind text, p_item uuid, p_variant uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_store uuid;
  v_at timestamptz;
  v_form text;
  v_ref text;
  v_loc uuid;
  v_unit uuid;
begin
  if not public.is_staff() then raise exception 'Brak uprawnień'; end if;
  if p_variant is null or not exists (select 1 from public.variants where id = p_variant) then
    raise exception 'Wybierz produkt i rozmiar z katalogu';
  end if;
  if p_kind = 'pos' then
    perform public.split_pos_item(p_item);
    select i.unit_id, i.ptu, i.status, o.store_id, o.created_at, o.code into r
      from public.pos_order_items i join public.pos_orders o on o.id = i.order_id where i.id = p_item for update of i;
    if not found then raise exception 'Nie ma takiej pozycji sprzedaży'; end if;
    if r.unit_id is not null then return r.unit_id; end if;
    v_store := r.store_id; v_at := r.created_at; v_ref := r.code;
    v_form := case when r.ptu = 'A' then 'vat_23' else 'vat_margin' end;
  elsif p_kind = 'invoice' then
    select it.unit_id, it.vat, inv.issue_date, inv.number into r
      from public.invoice_items it join public.invoices inv on inv.id = it.invoice_id where it.id = p_item for update of it;
    if not found then raise exception 'Nie ma takiej pozycji faktury'; end if;
    if r.unit_id is not null then return r.unit_id; end if;
    v_store := null; v_at := (r.issue_date::timestamp + interval '12 hours') at time zone 'Europe/Warsaw'; v_ref := r.number;
    v_form := case when r.vat = '23' then 'vat_23' else 'vat_margin' end;
  else
    raise exception 'Nieznany rodzaj pozycji';
  end if;

  select id into v_loc from public.locations where active and (v_store is null or store_id = v_store) order by created_at limit 1;
  if v_loc is null then raise exception 'Brak lokalizacji magazynu dla tego sklepu'; end if;

  insert into public.units (variant_id, location_id, status, owner_type, purchase_form, sold_at, received_at)
  values (p_variant, v_loc, 'sold', 'own', v_form, v_at, v_at)
  returning id into v_unit;

  if p_kind = 'pos' then
    update public.pos_order_items set unit_id = v_unit where id = p_item;
  else
    update public.invoice_items set unit_id = v_unit where id = p_item;
  end if;
  insert into public.unit_events (unit_id, type, data)
  values (v_unit, 'status', jsonb_build_object('to', 'sold', 'note', 'sztuka utworzona do sprzedanej pozycji ' || coalesce(v_ref, '') || ' (dołączenie umowy)'));
  return v_unit;
end $$;
revoke all on function public.create_line_unit(text, uuid, uuid) from public, anon;
grant execute on function public.create_line_unit(text, uuid, uuid) to authenticated;

-- Jednorazowo: pozycje Kasy, które już mają sztukę (umowa dołączona do pierwszej), a ilość > 1 –
-- pozostałe sztuki jako osobne pozycje (każda z „Dołącz umowę” w JPK).
do $$
declare i record; n int := 0;
begin
  for i in select id from public.pos_order_items where unit_id is not null and quantity > 1 and quantity = trunc(quantity) loop
    n := n + public.split_pos_item(i.id);
  end loop;
  raise notice 'Rozdzielone sztuki w Kasie: %', n;
end $$;

-- ───────── 3. JPK – „nie dotyczy” ─────────
create table if not exists public.jpk_na (
  line_key text primary key check (length(line_key) <= 120),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid() references public.profiles(id) on delete set null
);
alter table public.jpk_na enable row level security;
drop policy if exists jpk_na_staff on public.jpk_na;
create policy jpk_na_staff on public.jpk_na for all to authenticated using ((select public.is_staff())) with check ((select public.is_staff()));
revoke all on public.jpk_na from anon;
grant select, insert, delete on public.jpk_na to authenticated;

notify pgrst, 'reload schema';
