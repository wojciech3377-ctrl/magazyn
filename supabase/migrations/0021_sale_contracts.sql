-- Umowa do sprzedanego przedmiotu, który nie miał sztuki w magazynie: tworzy sprzedaną sztukę z tą umową
-- i przypina ją do linii sprzedaży (jedna umowa na przedmiot).
create or replace function public.attach_sale_unit(p_sale_id uuid, p_contract_id uuid, p_purchase_price numeric default null)
returns uuid
language plpgsql
as $$
declare
  s record;
  v_location uuid;
  v_unit uuid;
begin
  select * into s from public.sales where id = p_sale_id for update;
  if not found then raise exception 'Nie ma takiej sprzedaży'; end if;
  if s.unit_id is not null then raise exception 'Ten przedmiot ma już sztukę z magazynu – dołącz umowę do niej'; end if;
  if s.variant_id is null then raise exception 'Produkt nie jest powiązany z katalogiem – najpierw powiąż go w Katalogu'; end if;
  if s.status = 'cancelled' then raise exception 'Sprzedaż jest anulowana'; end if;

  select id into v_location from public.locations
   where active and (s.store_id is null or store_id = s.store_id)
   order by created_at limit 1;
  if v_location is null then raise exception 'Brak lokalizacji magazynu dla tego sklepu'; end if;

  insert into public.units (variant_id, location_id, status, owner_type, purchase_price, contract_id, sold_at, received_at)
  values (s.variant_id, v_location, 'sold', 'own', p_purchase_price, p_contract_id, s.sold_at, s.sold_at)
  returning id into v_unit;

  update public.sales set unit_id = v_unit, status = 'assigned' where id = p_sale_id;
  insert into public.unit_events (unit_id, type, data)
  values (v_unit, 'contract', jsonb_build_object('contract_id', p_contract_id, 'sale_id', p_sale_id, 'note', 'umowa dołączona do sprzedanego przedmiotu'));
  return v_unit;
end;
$$;
grant execute on function public.attach_sale_unit(uuid, uuid, numeric) to authenticated;
