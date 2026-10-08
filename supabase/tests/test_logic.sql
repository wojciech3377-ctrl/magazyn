-- Test logiki magazynu: FIFO (najpierw własne, potem komis), idempotencja, zamiana sztuki, RLS.
\set ON_ERROR_STOP on
begin;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000001', 'szef@example.com'),
  ('00000000-0000-0000-0000-000000000002', 'pracownik@example.com');

select role, can_see_prices from public.profiles order by email;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);

insert into public.locations (store_id, name, base_warehouse_id)
select id, 'Poznań – Długa 13', 'bl_1' from public.stores where code = 'sneakers-depot';
insert into public.locations (store_id, name, base_warehouse_id)
select id, 'Telefoniki – biuro', 'bl_2' from public.stores where code = 'telefoniki';

insert into public.products (id, title, style_sku) values ('10000000-0000-0000-0000-000000000001', 'YZY YS-01 Cream', '09390-10000YC-CREA');
insert into public.variants (id, product_id, option) values ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '39');
insert into public.consignors (id, name) values ('30000000-0000-0000-0000-000000000001', 'Jan Komisant');

-- komis przyjęty najwcześniej
select public.receive_delivery(
  (select id from public.stores where code = 'sneakers-depot'),
  (select id from public.locations where name = 'Poznań – Długa 13'),
  '20000000-0000-0000-0000-000000000001', 1, 'in_stock', 'consignment',
  '30000000-0000-0000-0000-000000000001', 'vat_margin', null, 400, null, '{}', null, 'komis');
update public.units set received_at = now() - interval '30 days';

-- dwie własne sztuki, przyjęte później
select public.receive_delivery(
  (select id from public.stores where code = 'sneakers-depot'),
  (select id from public.locations where name = 'Poznań – Długa 13'),
  '20000000-0000-0000-0000-000000000001', 2, 'in_stock', 'own', null, 'vat_margin', 500, null, null,
  array['IMEI-A', 'IMEI-B'], 'R1', 'własne');

select code, owner_type, purchase_form, identifier, status from public.units order by number;

-- sprzedaż 1 i 2 → własne sztuki; 3 → komis; 4 → brak sztuki
select public.register_sale((select id from public.stores where code = 'sneakers-depot'), 1001, 1, '20000000-0000-0000-0000-000000000001', 1, '#1001', 'YZY 39');
select public.register_sale((select id from public.stores where code = 'sneakers-depot'), 1002, 1, '20000000-0000-0000-0000-000000000001', 2, '#1002', 'YZY 39 x2');
select public.register_sale((select id from public.stores where code = 'sneakers-depot'), 1002, 1, '20000000-0000-0000-0000-000000000001', 2, '#1002', 'YZY 39 x2') as powtorka_nowych;

select s.order_ref, s.line_index, s.status, u.code, u.owner_type
from public.sales s left join public.units u on u.id = s.unit_id
order by s.base_order_id, s.line_index;

do $$
declare o text;
begin
  select u.owner_type into o from public.sales s join public.units u on u.id = s.unit_id
  where s.base_order_id = 1001;
  if o <> 'own' then raise exception 'FIFO: pierwsza sprzedaż powinna wziąć własną sztukę, wzięła %', o; end if;
  select u.owner_type into o from public.sales s join public.units u on u.id = s.unit_id
  where s.base_order_id = 1002 and s.line_index = 1;
  if o <> 'consignment' then raise exception 'FIFO: komis powinien iść po własnych, jest %', o; end if;
  if (select count(*) from public.sales) <> 3 then raise exception 'Powtórka zamówienia dodała linie'; end if;
end $$;

select public.register_sale(null, 1003, 1, '20000000-0000-0000-0000-000000000001', 1, '#1003', 'YZY 39') ;
select status from public.sales where base_order_id = 1003;

-- zwrot sztuki na stan i zamiana przy pakowaniu skanem IMEI
select public.return_unit((select id from public.units where identifier = 'IMEI-B'), true);
select order_ref, line_index, status from public.sales where base_order_id = 1002 order by line_index;

-- zamiana na anulowanej sprzedaży jest zablokowana (inaczej zwolniłaby sztukę innej sprzedaży)
do $$ begin
  perform public.swap_sale_unit((select id from public.sales where base_order_id = 1002 and line_index = 0), 'IMEI-A');
  raise exception 'swap na anulowanej sprzedaży powinien być zablokowany';
exception when others then
  if sqlerrm like 'swap na anulowanej%' then raise; end if;
  raise notice 'OK, blokada: %', sqlerrm;
end $$;
select public.swap_sale_unit((select id from public.sales where base_order_id = 1001), 'imei-b');
select s.order_ref, u.code, u.identifier, s.status from public.sales s join public.units u on u.id = s.unit_id where s.base_order_id = 1001;
select code, identifier, status from public.units order by number;

-- pracownik nie usuwa sztuk (tylko administrator)
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
update public.profiles set active = true where false; -- pracownik nieaktywny, dopóki admin go nie włączy
select count(*) as widoczne_dla_nieaktywnego from public.units;
reset role;
update public.profiles set active = true where id = '00000000-0000-0000-0000-000000000002';
set local role authenticated;
delete from public.units where code = 'S000002';
select count(*) as po_probie_usuniecia from public.units;

-- RLS: konto bez profilu nie widzi nic
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000099', true);
select count(*) as widoczne_sztuki_obcego from public.units;

-- pracownik (nie admin) nie może zmieniać sklepów
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
select count(*) as widoczne_sztuki_pracownika from public.units;
update public.stores set name = 'X';
select name from public.stores order by code;

rollback;
