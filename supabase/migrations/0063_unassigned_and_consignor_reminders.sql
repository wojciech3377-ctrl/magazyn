-- 0063: (1) rzeczy spoza katalogu Shopify (paczka komisanta, umowa z linku ogólnego) – produkt „nieprzypisany do Shopify”,
--          sztuka normalnie w magazynie, przypisanie do produktu z katalogu później, ręcznie;
--       (2) przypomnienia komisantom o niepodpisanej umowie (co 5 godzin).

alter table public.products add column if not exists unassigned boolean not null default false;
create index if not exists products_unassigned_idx on public.products (id) where unassigned;
alter table public.contracts add column if not exists reminded_at timestamptz;

-- Pole wyliczane do filtra listy sztuk: units_list?unassigned=is.true
create or replace function public.unassigned(public.units_list) returns boolean
language sql stable set search_path = public as $$
  select coalesce((select p.unassigned from public.products p where p.id = $1.product_id), false)
$$;
grant execute on function public.unassigned(public.units_list) to authenticated;

-- Produkt + rozmiar „nieprzypisany do Shopify” (nazwa i rozmiar od komisanta / klienta).
create or replace function public.create_unassigned_variant(p_title text, p_option text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_product uuid; v_variant uuid;
begin
  if auth.uid() is not null and not public.is_staff() then raise exception 'Brak uprawnień'; end if;
  insert into public.products (title, unassigned) values (left(coalesce(nullif(trim(p_title), ''), 'Przedmiot bez nazwy'), 200), true)
  returning id into v_product;
  insert into public.variants (product_id, option) values (v_product, left(coalesce(nullif(trim(p_option), ''), 'jeden rozmiar'), 100))
  returning id into v_variant;
  return v_variant;
end $$;
revoke all on function public.create_unassigned_variant(text, text) from public, anon;
grant execute on function public.create_unassigned_variant(text, text) to authenticated;

-- Przypisanie sztuki nieprzypisanego produktu do rozmiaru z katalogu. Pusty produkt tymczasowy znika.
create or replace function public.assign_unit_variant(p_unit uuid, p_variant uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u record; v_old_product uuid; v_unassigned boolean;
begin
  if auth.uid() is not null and not public.is_staff() then raise exception 'Brak uprawnień'; end if;
  select * into u from public.units where id = p_unit for update;
  if not found then raise exception 'Nie ma takiej sztuki'; end if;
  select v.product_id, p.unassigned into v_old_product, v_unassigned from public.variants v join public.products p on p.id = v.product_id where v.id = u.variant_id;
  if not coalesce(v_unassigned, false) then raise exception 'Ta sztuka jest już przypisana do produktu z Shopify'; end if;
  if not exists (select 1 from public.variants v join public.products p on p.id = v.product_id where v.id = p_variant and not p.unassigned) then
    raise exception 'Wybierz rozmiar produktu z katalogu (ze Shopify)';
  end if;
  update public.units set variant_id = p_variant where id = p_unit;
  update public.consignor_intake_items set variant_id = p_variant where unit_id = p_unit;
  update public.contracts set items = (
    select jsonb_agg(case when it->>'variant_id' = u.variant_id::text then jsonb_set(it, '{variant_id}', to_jsonb(p_variant::text)) else it end)
    from jsonb_array_elements(items) it)
  where id = u.contract_id and items is not null;
  insert into public.unit_events (unit_id, type, data) values (p_unit, 'edited', jsonb_build_object('note', 'przypisana do produktu z Shopify', 'from_variant', u.variant_id, 'to_variant', p_variant));
  -- Tymczasowy produkt bez sztuk i sprzedaży – usuwamy.
  delete from public.variants v where v.product_id = v_old_product
    and not exists (select 1 from public.units x where x.variant_id = v.id)
    and not exists (select 1 from public.sales s where s.variant_id = v.id);
  delete from public.products p where p.id = v_old_product and not exists (select 1 from public.variants v where v.product_id = p.id);
  return jsonb_build_object('status', u.status, 'location_id', u.location_id, 'from_variant', u.variant_id);
end $$;
revoke all on function public.assign_unit_variant(uuid, uuid) from public, anon;
grant execute on function public.assign_unit_variant(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
