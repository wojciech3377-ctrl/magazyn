-- 0059: JPK – notatka do każdej linii; „Dołącz umowę” także do pozycji bez sztuki z magazynu
-- (sprzedaż stacjonarna wpisana z nazwy / produkt własny, faktura wystawiona ręcznie).

create table if not exists public.jpk_notes (
  line_key text primary key check (length(line_key) <= 120),
  note text not null check (length(note) <= 500),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid() references public.profiles(id) on delete set null
);
alter table public.jpk_notes enable row level security;
drop policy if exists jpk_notes_staff on public.jpk_notes;
create policy jpk_notes_staff on public.jpk_notes for all to authenticated using (public.is_staff()) with check (public.is_staff());
revoke all on public.jpk_notes from anon;

-- Sprzedana sztuka dla pozycji bez sztuki: wybrany produkt i rozmiar z katalogu, data sprzedaży z paragonu / faktury.
-- Potem do tej sztuki dołącza się umowę jak do każdej innej (gotowa, skan albo do podpisu).
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

notify pgrst, 'reload schema';
