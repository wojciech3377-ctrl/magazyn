-- 0062: rzeczy znikające z umowy na kilka – także gdy znikają WSZYSTKIE naraz, każda dostaje osobną umowę
-- (5 rzeczy → 5 umów: pierwotna zostaje przy jednej, 4 nowe). Zastępuje wyzwalacze z 0060 (SQL 60 może być już uruchomiony –
-- ten plik działa w obu przypadkach). Jedna rzecz na umowie – bez podziału, umowa wraca do niewykorzystanych.

create or replace function public.split_contract_for_unit(
  p_contract uuid, p_unit uuid, p_variant uuid, p_code text, p_owner text, p_purchase numeric, p_payout numeric
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  c record;
  v_title text;
  v_option text;
  v_price numeric;
  v_items jsonb;
  v_idx int;
  v_midx int;
  v_mqty int;
  v_new uuid;
begin
  select * into c from public.contracts where id = p_contract for update;
  if not found or c.status <> 'accepted' then return null; end if;
  -- Którą rzecz wydzielić, a która zostaje przy pierwotnej umowie – decydują wyzwalacze (units_split_contract_*).

  select p.title, v.option into v_title, v_option
    from public.variants v join public.products p on p.id = v.product_id where v.id = p_variant;

  -- Kwota tej rzeczy: pozycja umowy przypisana do sztuki → „kwota za każdą rzecz” → cena zakupu / kwota komisanta.
  v_items := coalesce(c.items, '[]'::jsonb);
  select k - 1 into v_idx from jsonb_array_elements(v_items) with ordinality e(it, k) where it->>'unit_id' = p_unit::text limit 1;
  if v_idx is null then
    select k - 1 into v_idx from jsonb_array_elements(v_items) with ordinality e(it, k)
      where coalesce(it->>'unit_id', '') = '' and it->>'variant_id' = p_variant::text limit 1;
  end if;
  -- Przedmiot faktury wpisany ręcznie, którego nazwa pasuje do produktu (np. „Air Force 1” × 5) – zmniejszamy jego ilość.
  if v_idx is null and v_title is not null then
    select k - 1, greatest(coalesce(nullif(it->>'qty', '')::int, 1), 1) into v_midx, v_mqty
      from jsonb_array_elements(v_items) with ordinality e(it, k)
      where coalesce(it->>'unit_id', '') = '' and coalesce(it->>'variant_id', '') = '' and length(trim(coalesce(it->>'title', ''))) >= 3
        and (position(lower(trim(it->>'title')) in lower(v_title)) > 0 or position(lower(v_title) in lower(trim(it->>'title'))) > 0)
      limit 1;
  end if;
  if v_idx is not null and coalesce(nullif(v_items->v_idx->>'price', '')::numeric, 0) > 0 then
    v_price := (v_items->v_idx->>'price')::numeric;
  elsif c.amount_per_item then
    v_price := c.amount;
  else
    v_price := case when p_owner = 'consignment' then p_payout else p_purchase end;
    if v_price is null and v_midx is not null then v_price := nullif(nullif(v_items->v_midx->>'price', '')::numeric, 0); end if;
  end if;

  insert into public.contracts (
    type, counterparty, consignor_id, contract_date, amount, currency, amount_per_item, vat_form, doc_number,
    file_path, file_name, notes, status, source, template, items, group_id, accepted_at, paid_at, created_by
  ) values (
    c.type, c.counterparty, c.consignor_id, c.contract_date, v_price, c.currency, true, c.vat_form, c.doc_number,
    c.file_path, c.file_name,
    left(concat_ws(' · ', 'Wydzielona z umowy NR' || c.number || ' – ' || coalesce(p_code, 'sztuka') || ' usunięta z magazynu', c.notes), 1000),
    'accepted', c.source, null,
    jsonb_build_array(jsonb_build_object('title', coalesce(v_title, 'przedmiot'), 'option', coalesce(v_option, ''), 'qty', 1, 'price', coalesce(v_price, 0), 'manual', true)),
    coalesce(c.group_id, c.id), c.accepted_at, c.paid_at, c.created_by
  ) returning id into v_new;

  -- Pierwotna umowa: bez tej pozycji, kwota „za całość” pomniejszona o wydzieloną.
  if v_idx is not null then
    v_items := v_items - v_idx;
  elsif v_midx is not null then
    v_items := case when v_mqty > 1 then jsonb_set(v_items, array[v_midx::text, 'qty'], to_jsonb(v_mqty - 1)) else v_items - v_midx end;
  end if;
  update public.contracts set
    items = case when c.items is null then null else v_items end,
    amount = case when not amount_per_item and amount is not null and v_price is not null then greatest(amount - v_price, 0) else amount end
  where id = p_contract;
  return v_new;
end $$;
revoke all on function public.split_contract_for_unit(uuid, uuid, uuid, text, text, numeric, numeric) from public, anon, authenticated;

-- Wspólna logika dla jednej umowy: rzeczy, które właśnie zniknęły (gone) → osobne umowy. Gdy na umowie nie zostaje
-- żadna rzecz w obrocie, najstarsza ze zniknionych zostaje przy pierwotnej umowie (bez podziału).
create or replace function public.split_gone_units(p_contract uuid, p_units jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_keep uuid;
  r record;
  v_new uuid;
begin
  if not exists (
    select 1 from public.units u where u.contract_id = p_contract and u.status not in ('removed', 'consignor_returned')
      and not (u.id::text in (select x->>'id' from jsonb_array_elements(p_units) x))
  ) then
    select (x->>'id')::uuid into v_keep from jsonb_array_elements(p_units) x order by (x->>'number')::bigint limit 1;
  end if;
  for r in select x from jsonb_array_elements(p_units) x order by (x->>'number')::bigint loop
    if (r.x->>'id')::uuid is not distinct from v_keep then continue; end if;
    v_new := public.split_contract_for_unit(p_contract, (r.x->>'id')::uuid, (r.x->>'variant_id')::uuid, r.x->>'code', r.x->>'owner_type',
      nullif(r.x->>'purchase_price', '')::numeric, nullif(r.x->>'payout_amount', '')::numeric);
    -- Wycofana przez automat zostawia umowę przy sztuce – teraz wskazuje swoją, wydzieloną umowę.
    if v_new is not null and (r.x->>'still')::boolean then
      update public.units set contract_id = v_new where id = (r.x->>'id')::uuid and contract_id = p_contract;
    end if;
  end loop;
end $$;
revoke all on function public.split_gone_units(uuid, jsonb) from public, anon, authenticated;

drop trigger if exists units_split_contract_upd on public.units;
drop trigger if exists units_split_contract_del on public.units;
drop function if exists public.units_split_contract_upd();
drop function if exists public.units_split_contract_del();

-- Sztuki wycofane / wydane poza sklep (status „removed”) w jednym poleceniu.
create or replace function public.units_split_contract_upd_stmt() returns trigger
language plpgsql security definer set search_path = public as $$
declare c record;
begin
  for c in
    select o.contract_id as cid,
           jsonb_agg(jsonb_build_object('id', n.id, 'number', n.number, 'variant_id', n.variant_id, 'code', n.code, 'owner_type', n.owner_type,
             'purchase_price', n.purchase_price, 'payout_amount', n.payout_amount, 'still', n.contract_id is not distinct from o.contract_id)) as units
    from new_units n join old_units o on o.id = n.id
    where o.contract_id is not null and o.status <> 'removed' and n.status = 'removed'
    group by o.contract_id
  loop
    perform public.split_gone_units(c.cid, c.units);
  end loop;
  return null;
end $$;
revoke all on function public.units_split_contract_upd_stmt() from public, anon, authenticated;
drop trigger if exists units_split_contract_upd_stmt on public.units;
create trigger units_split_contract_upd_stmt after update on public.units
  referencing old table as old_units new table as new_units
  for each statement execute function public.units_split_contract_upd_stmt();

-- Sztuki usunięte z magazynu w jednym poleceniu.
create or replace function public.units_split_contract_del_stmt() returns trigger
language plpgsql security definer set search_path = public as $$
declare c record;
begin
  for c in
    select g.contract_id as cid,
           jsonb_agg(jsonb_build_object('id', g.id, 'number', g.number, 'variant_id', g.variant_id, 'code', g.code, 'owner_type', g.owner_type,
             'purchase_price', g.purchase_price, 'payout_amount', g.payout_amount, 'still', false)) as units
    from gone_units g
    where g.contract_id is not null and g.status <> 'removed'
    group by g.contract_id
  loop
    perform public.split_gone_units(c.cid, c.units);
  end loop;
  return null;
end $$;
revoke all on function public.units_split_contract_del_stmt() from public, anon, authenticated;
drop trigger if exists units_split_contract_del_stmt on public.units;
create trigger units_split_contract_del_stmt after delete on public.units
  referencing old table as gone_units
  for each statement execute function public.units_split_contract_del_stmt();

notify pgrst, 'reload schema';
