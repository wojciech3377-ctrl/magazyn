-- Test paragonów (PAR/miesiąc/numer) i przesunięć między magazynami.
\set ON_ERROR_STOP on
begin;
-- Paragony: numeracja od 1 w każdym miesiącu, osobno od faktur; faktura i paragon do tego samego zamówienia.
select number from public.create_invoice('{"kind":"receipt","issue_date":"2026-10-09","seller":{},"buyer":{"name":"Klient"},"total_gross":100,"net_23":0,"vat_23":0,"margin_total":100}', '[{"name":"Buty","unit_price_gross":100,"total_gross":100,"vat":"margin"}]');
select number from public.create_invoice('{"kind":"receipt","issue_date":"2026-10-20","seller":{},"buyer":{"name":"Klient"},"total_gross":100,"net_23":0,"vat_23":0,"margin_total":100}', '[{"name":"Buty","unit_price_gross":100,"total_gross":100,"vat":"margin"}]');
select number from public.create_invoice('{"kind":"receipt","issue_date":"2026-11-02","seller":{},"buyer":{"name":"Klient"},"total_gross":100,"net_23":0,"vat_23":0,"margin_total":100}', '[{"name":"Buty","unit_price_gross":100,"total_gross":100,"vat":"margin"}]');
select number from public.create_invoice('{"kind":"receipt","issue_date":"2027-10-02","seller":{},"buyer":{"name":"Klient"},"total_gross":100,"net_23":0,"vat_23":0,"margin_total":100}', '[{"name":"Buty","unit_price_gross":100,"total_gross":100,"vat":"margin"}]');
select number from public.create_invoice('{"issue_date":"2026-10-09","seller":{},"buyer":{"name":"Jan"},"total_gross":100,"net_23":0,"vat_23":0,"margin_total":100}', '[{"name":"Buty","unit_price_gross":100,"total_gross":100,"vat":"margin"}]');
do $$ begin
  if (select string_agg(number, ',' order by issue_date) from public.invoices where kind = 'receipt') <> 'PAR/10/1,PAR/10/2,PAR/11/1,PAR/10/1' then
    raise exception 'zła numeracja paragonów: %', (select string_agg(number, ',' order by created_at, number) from public.invoices where kind = 'receipt');
  end if;
  if not exists (select 1 from public.invoices where number = 'FVM/1/2026') then raise exception 'faktura powinna mieć FVM/1/2026'; end if;
  -- usunięcie ostatniego paragonu w miesiącu zwalnia numer
  perform public.delete_invoice((select id from public.invoices where number = 'PAR/10/2'));
  if (select number from public.create_invoice('{"kind":"receipt","issue_date":"2026-10-21","seller":{},"buyer":{"name":"Klient"},"total_gross":1,"net_23":0,"vat_23":0,"margin_total":1}', '[{"name":"Buty","unit_price_gross":1,"total_gross":1,"vat":"margin"}]')) <> 'PAR/10/2' then
    raise exception 'numer po usunięciu powinien wrócić';
  end if;
end $$;
rollback;

begin;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000001', 'szef@example.com');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
insert into public.locations (store_id, name) select id, 'Poznań' from public.stores where code = 'sneakers-depot' returning name;
insert into public.locations (store_id, name) select id, 'Warszawa' from public.stores where code = 'sneakers-depot' returning name;
insert into public.products (id, title) values ('10000000-0000-0000-0000-000000000001', 'Balenciaga Track Black');
insert into public.variants (id, product_id, option) values ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '42');
select public.receive_delivery(
  (select id from public.stores where code = 'sneakers-depot'), (select id from public.locations where name = 'Poznań'),
  '20000000-0000-0000-0000-000000000001', 3, 'in_stock', 'own', null, 'vat_margin', 500, null, null, '{}', null, 'test');
do $$
declare
  v_t uuid;
  v_from uuid := (select id from public.locations where name = 'Poznań');
  v_to uuid := (select id from public.locations where name = 'Warszawa');
  v_units uuid[] := (select array_agg(id order by number) from public.units);
  n int;
begin
  -- źródło = cel – błąd
  begin
    perform public.create_stock_transfer(v_from, v_from, v_units[1:1]);
    raise exception 'ten sam magazyn nie powinien przejść';
  exception when raise_exception then
    if sqlerrm not like 'Wybierz inny%' then raise; end if;
  end;
  v_t := public.create_stock_transfer(v_from, v_to, v_units[1:2], 'paczka 1');
  if (select count(*) from public.units where status = 'in_transit' and location_id = v_to and transfer_id = v_t) <> 2 then raise exception 'sztuki powinny być w drodze do celu'; end if;
  -- ta sama sztuka drugi raz – błąd
  begin
    perform public.create_stock_transfer(v_from, v_to, v_units[1:1]);
    raise exception 'sztuka w drodze nie powinna przejść';
  exception when raise_exception then
    if sqlerrm not like 'Sztuki nie są na stanie%' then raise; end if;
  end;
  -- przyjęcie jednej sztuki, potem reszty
  select count(*) into n from public.receive_stock_transfer(v_t, v_units[1:1]);
  if n <> 1 or (select status from public.stock_transfers where id = v_t) <> 'in_transit' then raise exception 'częściowe przyjęcie'; end if;
  select count(*) into n from public.receive_stock_transfer(v_t);
  if n <> 1 or (select status from public.stock_transfers where id = v_t) <> 'received' then raise exception 'pełne przyjęcie'; end if;
  if (select count(*) from public.units where status = 'in_stock' and location_id = v_to and transfer_id is null) <> 2 then raise exception 'sztuki powinny być na stanie w celu'; end if;
  -- anulowanie: sztuka wraca do źródła
  v_t := public.create_stock_transfer(v_from, v_to, v_units[3:3]);
  select count(*) into n from public.cancel_stock_transfer(v_t);
  if n <> 1 or (select status from public.stock_transfers where id = v_t) <> 'cancelled' then raise exception 'anulowanie'; end if;
  if (select location_id from public.units where id = v_units[3]) <> v_from or (select status from public.units where id = v_units[3]) <> 'in_stock' then raise exception 'sztuka powinna wrócić'; end if;
end $$;
select s.number, s.status, count(i.*) as szt from public.stock_transfers s join public.stock_transfer_items i on i.transfer_id = s.id group by 1, 2 order by 1;
rollback;
