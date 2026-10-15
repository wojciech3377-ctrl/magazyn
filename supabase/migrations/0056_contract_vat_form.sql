-- 0056: forma VAT umowy – FV marża albo FV 23%. Umowę na marżę można przypiąć tylko do rzeczy z formą „VAT marża”,
-- umowę na 23% – tylko do rzeczy „23%”. Pilnuje tego baza (każde miejsce w aplikacji). Puste – bez ograniczeń (stare umowy).
alter table public.contracts add column if not exists vat_form text;
alter table public.contracts drop constraint if exists contracts_vat_form_check;
alter table public.contracts add constraint contracts_vat_form_check check (vat_form is null or vat_form in ('vat_margin', 'vat_23'));

create or replace function public.vat_form_label(f text) returns text language sql immutable set search_path = public as $$
  select case f when 'vat_margin' then 'FV marża' when 'vat_23' then 'FV 23%' else coalesce(f, '–') end
$$;

create or replace function public.unit_form_label(f text) returns text language sql immutable set search_path = public as $$
  select case f when 'vat_margin' then 'VAT marża' when 'vat_23' then '23%' else coalesce(f, '–') end
$$;

-- Sztuka: nowa sztuka z umowy dostaje formę umowy; przypięcie / zmiana formy niezgodnej z umową – błąd z wyjaśnieniem.
create or replace function public.units_contract_vat() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  c record;
  code text := 'S' || lpad(new.number::text, 6, '0');
begin
  if new.contract_id is null then return new; end if;
  select vat_form, coalesce(doc_number, case when number is not null then 'NR' || number::text end, counterparty) as label
    into c from public.contracts where id = new.contract_id;
  if c.vat_form is null then return new; end if;
  if tg_op = 'INSERT' then
    new.purchase_form := c.vat_form;
    return new;
  end if;
  if (new.contract_id is distinct from old.contract_id or new.purchase_form is distinct from old.purchase_form)
     and new.purchase_form is distinct from c.vat_form then
    raise exception 'Sztuka % ma formę sprzedaży „%”, a umowa % to % – można ją przypiąć tylko do rzeczy z formą „%”. Zmień formę sprzedaży sztuki albo wybierz inną umowę.',
      code, unit_form_label(new.purchase_form), c.label, vat_form_label(c.vat_form), unit_form_label(c.vat_form)
      using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function public.units_contract_vat() from public, anon, authenticated;
drop trigger if exists units_contract_vat on public.units;
create trigger units_contract_vat before insert or update of contract_id, purchase_form on public.units
  for each row execute function public.units_contract_vat();

-- Umowa: zmiana formy VAT, gdy są przypięte rzeczy z inną formą – błąd.
create or replace function public.contracts_vat_form_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare bad text;
begin
  if new.vat_form is null or new.vat_form is not distinct from old.vat_form then return new; end if;
  select string_agg('S' || lpad(number::text, 6, '0'), ', ') into bad
    from (select number from public.units where contract_id = new.id and purchase_form is distinct from new.vat_form limit 10) x;
  if bad is not null then
    raise exception 'Nie można ustawić % – przypięte rzeczy mają inną formę sprzedaży niż „%”: %. Najpierw zmień ich formę albo je odepnij.', vat_form_label(new.vat_form), unit_form_label(new.vat_form), bad
      using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function public.contracts_vat_form_guard() from public, anon, authenticated;
drop trigger if exists contracts_vat_form_guard on public.contracts;
create trigger contracts_vat_form_guard before update of vat_form on public.contracts
  for each row execute function public.contracts_vat_form_guard();

notify pgrst, 'reload schema';
