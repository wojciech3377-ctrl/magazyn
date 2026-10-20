-- 0074: „Dołącz umowę” do sprzedanego przedmiotu bez sztuki – gdy zamówienie jeszcze nie wyszło (status „nowe”),
-- sztuka powstaje „w drodze” pod to zamówienie (Przyjęcie dostawy → W drodze); po przyjęciu trafia do zamówienia
-- (nie na stan). Umowa jest przy sprzedaży od razu (JPK). Zamówienie już wysłane – jak dotąd: sztuka sprzedana.
-- Można uruchomić kilka razy.

drop function if exists public.attach_sale_unit(uuid, uuid, numeric, uuid);
create or replace function public.attach_sale_unit(p_sale_id uuid, p_contract_id uuid, p_purchase_price numeric default null,
  p_variant_id uuid default null, p_in_transit boolean default null)
returns uuid
language plpgsql
set search_path = public, extensions
as $$
declare
  s record;
  v_location uuid;
  v_unit uuid;
  v_transit boolean;
begin
  select * into s from public.sales where id = p_sale_id for update;
  if not found then raise exception 'Nie ma takiej sprzedaży'; end if;
  if s.unit_id is not null then raise exception 'Ten przedmiot ma już sztukę z magazynu – dołącz umowę do niej'; end if;
  if s.status = 'cancelled' then raise exception 'Sprzedaż jest anulowana'; end if;
  if s.variant_id is null and p_variant_id is not null then
    update public.sales set variant_id = p_variant_id, status = 'no_unit' where id = p_sale_id;
    s.variant_id := p_variant_id;
  end if;
  if s.variant_id is null then raise exception 'Wybierz produkt i rozmiar z katalogu (pozycja nie jest powiązana z katalogiem)'; end if;

  select id into v_location from public.locations
   where active and (s.store_id is null or store_id = s.store_id)
   order by created_at limit 1;
  if v_location is null then raise exception 'Brak lokalizacji magazynu dla tego sklepu'; end if;

  -- Bez wskazania: w drodze, gdy zamówienie jeszcze nie wyszło.
  v_transit := coalesce(p_in_transit, exists (
    select 1 from public.orders o where o.id = s.order_id and o.status = 'new' and o.cancelled_at is null));

  if v_transit then
    insert into public.units (variant_id, location_id, status, owner_type, purchase_price, contract_id, received_at, notes)
    values (s.variant_id, v_location, 'in_transit', 'own', p_purchase_price, p_contract_id, now(), 'pod zamówienie ' || coalesce(s.order_ref, ''))
    returning id into v_unit;
  else
    insert into public.units (variant_id, location_id, status, owner_type, purchase_price, contract_id, sold_at, received_at)
    values (s.variant_id, v_location, 'sold', 'own', p_purchase_price, p_contract_id, s.sold_at, s.sold_at)
    returning id into v_unit;
  end if;

  update public.sales set unit_id = v_unit, status = 'assigned' where id = p_sale_id;
  insert into public.unit_events (unit_id, type, data)
  values (v_unit, 'contract', jsonb_build_object('contract_id', p_contract_id, 'sale_id', p_sale_id,
    'note', case when v_transit then 'umowa do zamówienia – rzecz w drodze' else 'umowa dołączona do sprzedanego przedmiotu' end));
  return v_unit;
end;
$$;
grant execute on function public.attach_sale_unit(uuid, uuid, numeric, uuid, boolean) to authenticated;

notify pgrst, 'reload schema';
