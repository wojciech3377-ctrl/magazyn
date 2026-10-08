-- Umowy: po podpisie sprzedającego czekają na zatwierdzenie przez sklep (dopiero wtedy podpis kupującego,
-- PDF dla sprzedającego i sztuki „w drodze”). Wklej całość w Supabase → SQL Editor → Run.

alter table public.contracts drop constraint if exists contracts_status_check;
alter table public.contracts add constraint contracts_status_check
  check (status in ('sent', 'signed', 'accepted', 'rejected', 'cancelled'));

alter table public.contracts
  add column if not exists accepted_at timestamptz,
  add column if not exists accepted_by uuid references auth.users (id);

-- Umowy z szablonu podpisane wcześniej (przed tą zmianą) uznajemy za zatwierdzone.
update public.contracts set status = 'accepted', accepted_at = coalesce(signed_at, now())
where template is not null and status = 'signed' and units_created_at is not null;

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
  if c.status <> 'accepted' then raise exception 'Umowa nie jest zatwierdzona'; end if;
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
      -- sztuka mogła zostać usunięta w międzyczasie – wtedy tylko pomijamy
      if found then
        insert into public.unit_events (unit_id, type, data)
        values ((it ->> 'unit_id')::uuid, 'contract', jsonb_build_object('contract_id', c.id, 'signed', true));
      end if;
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
    where id = c.sale_id and unit_id is null and status = 'no_unit';
  end if;

  update public.contracts set units_created_at = now() where id = c.id;
  return jsonb_build_object('created_units', v_created);
end;
$$;
