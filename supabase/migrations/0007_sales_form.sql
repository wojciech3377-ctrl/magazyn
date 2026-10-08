-- Forma sprzedaży: tylko „VAT marża” albo „23% VAT” (także dla komisu).
-- Wklej całość w Supabase → SQL Editor → Run.

alter table public.units drop constraint if exists units_purchase_form_check;
update public.units set purchase_form = case when purchase_form = 'invoice' then 'vat_23' else 'vat_margin' end
where purchase_form not in ('vat_margin', 'vat_23');
alter table public.units add constraint units_purchase_form_check check (purchase_form in ('vat_margin', 'vat_23'));

create or replace function public.receive_delivery(
  p_store_id uuid,
  p_location_id uuid,
  p_variant_id uuid,
  p_quantity int,
  p_status text default 'in_stock',
  p_owner_type text default 'own',
  p_consignor_id uuid default null,
  p_purchase_form text default 'vat_margin',
  p_purchase_price numeric default null,
  p_payout_amount numeric default null,
  p_contract_id uuid default null,
  p_identifiers text[] default '{}',
  p_shelf text default null,
  p_note text default null,
  p_delivery_id uuid default null
)
returns uuid
language plpgsql
as $$
declare
  v_delivery uuid := p_delivery_id;
  v_unit uuid;
  i int;
begin
  if p_quantity is null or p_quantity < 1 or p_quantity > 500 then
    raise exception 'Liczba sztuk musi być od 1 do 500';
  end if;
  if p_status not in ('in_stock', 'in_transit') then
    raise exception 'Nowa sztuka może być tylko na stanie albo w drodze';
  end if;
  if not exists (select 1 from public.locations where id = p_location_id and store_id = p_store_id) then
    raise exception 'Lokalizacja nie należy do wybranego sklepu';
  end if;
  if p_owner_type = 'consignment' and p_consignor_id is null then
    raise exception 'Dla komisu wybierz komisanta';
  end if;

  if v_delivery is null then
    insert into public.deliveries (store_id, location_id, note)
    values (p_store_id, p_location_id, p_note)
    returning id into v_delivery;
  elsif not exists (select 1 from public.deliveries where id = v_delivery and location_id = p_location_id) then
    raise exception 'Dostawa % nie istnieje albo ma inną lokalizację', v_delivery;
  end if;

  for i in 1..p_quantity loop
    insert into public.units (
      variant_id, location_id, delivery_id, status, owner_type, consignor_id,
      purchase_form, purchase_price, payout_amount, identifier, shelf, contract_id
    ) values (
      p_variant_id, p_location_id, v_delivery, p_status, p_owner_type,
      case when p_owner_type = 'consignment' then p_consignor_id end,
      case when p_purchase_form = 'vat_23' then 'vat_23' else 'vat_margin' end,
      p_purchase_price, p_payout_amount,
      nullif(upper(trim(coalesce(p_identifiers[i], ''))), ''),
      p_shelf, p_contract_id
    ) returning id into v_unit;

    insert into public.unit_events (unit_id, type, data)
    values (v_unit, 'received', jsonb_build_object('delivery_id', v_delivery, 'status', p_status));
  end loop;

  return v_delivery;
end;
$$;
