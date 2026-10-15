-- 0060: umowa na kilka rzeczy, z której część znika z magazynu (usunięta sztuka, „wydaj poza sklepem”, wycofana przez
-- automat stanów). Dla każdej takiej rzeczy powstaje osobna umowa z tym samym plikiem i numerem dokumentu, z kwotą tej
-- rzeczy i jej nazwą w „Przedmiotach faktury” – trafia do niewykorzystanych. Pierwotna umowa zostaje z pozostałymi
-- rzeczami (kwota „za całość” zmniejsza się o kwotę wydzieloną). Gdy znikają wszystkie rzeczy naraz – nic się nie
-- dzieli, cała umowa wraca do niewykorzystanych jak dotąd.

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
  -- Inne rzeczy tej umowy, które nadal są w obrocie. Brak – umowa zostaje w całości (wraca do niewykorzystanych).
  if not exists (
    select 1 from public.units u
    where u.contract_id = p_contract and u.id <> p_unit and u.status not in ('removed', 'consignor_returned')
  ) then return null; end if;

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

-- Sztuka wycofana / wydana poza sklep (status „removed”).
create or replace function public.units_split_contract_upd() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_new uuid;
begin
  if old.contract_id is null or old.status = 'removed' or new.status <> 'removed' then return null; end if;
  v_new := public.split_contract_for_unit(old.contract_id, new.id, new.variant_id, new.code, new.owner_type, new.purchase_price, new.payout_amount);
  -- Wycofana przez automat zostawia umowę przy sztuce – teraz wskazuje jej własną, wydzieloną umowę.
  if v_new is not null and new.contract_id = old.contract_id then
    update public.units set contract_id = v_new where id = new.id and contract_id = old.contract_id;
  end if;
  return null;
end $$;
revoke all on function public.units_split_contract_upd() from public, anon, authenticated;
drop trigger if exists units_split_contract_upd on public.units;
create trigger units_split_contract_upd after update of status on public.units
  for each row execute function public.units_split_contract_upd();

-- Sztuka usunięta z magazynu.
create or replace function public.units_split_contract_del() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.contract_id is null or old.status = 'removed' then return null; end if;
  perform public.split_contract_for_unit(old.contract_id, old.id, old.variant_id, old.code, old.owner_type, old.purchase_price, old.payout_amount);
  return null;
end $$;
revoke all on function public.units_split_contract_del() from public, anon, authenticated;
drop trigger if exists units_split_contract_del on public.units;
create trigger units_split_contract_del after delete on public.units
  for each row execute function public.units_split_contract_del();

notify pgrst, 'reload schema';
