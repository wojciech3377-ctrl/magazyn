-- Test umowy pod zamówienie i przyjęcia towaru w drodze.
\set ON_ERROR_STOP on
begin;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000001', 'szef@example.com');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
insert into public.locations (id, store_id, name) select '30000000-0000-0000-0000-000000000001', id, 'Sklep' from public.stores where code = 'sneakers-depot';
insert into public.products (id, title) values ('10000000-0000-0000-0000-000000000001', 'Air Jordan 4');
insert into public.variants (id, product_id, option) values ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '42');
-- zamówienie bez sztuki na stanie
select public.register_sale(null, 5001, 1, '20000000-0000-0000-0000-000000000001', 1, '#5001', 'AJ4 42');
select status from public.sales;
-- umowa pod zamówienie + zwykły skup jednej pary
insert into public.contracts (id, type, counterparty, template, status, sale_id, location_id, items)
values ('40000000-0000-0000-0000-000000000001', 'purchase', 'Jan', 'purchase_v1', 'accepted',
  (select id from public.sales limit 1), '30000000-0000-0000-0000-000000000001',
  '[{"variant_id": "20000000-0000-0000-0000-000000000001", "title": "AJ4", "option": "42", "price": 900, "qty": 1}]');
insert into public.contracts (id, type, counterparty, template, status, location_id, items)
values ('40000000-0000-0000-0000-000000000002', 'purchase', 'Ola', 'purchase_v1', 'accepted', '30000000-0000-0000-0000-000000000001',
  '[{"variant_id": "20000000-0000-0000-0000-000000000001", "title": "AJ4", "option": "42", "price": 800, "qty": 1}]');
select public.finalize_contract('40000000-0000-0000-0000-000000000001');
select public.finalize_contract('40000000-0000-0000-0000-000000000002');
select s.status, u.code, u.status as unit_status from public.sales s join public.units u on u.id = s.unit_id;
select to_status from public.receive_in_transit(array(select id from public.units)) order by 1;
select code, status, purchase_price from public.units order by number;
-- ponowne utworzenie sztuk zablokowane; umowa ogólna bez przypisanego produktu też
do $$ begin
  perform public.finalize_contract('40000000-0000-0000-0000-000000000001');
  raise exception 'powtórka powinna być zablokowana';
exception when others then
  if sqlerrm like 'powtórka%' then raise; end if;
  raise notice 'OK: %', sqlerrm;
end $$;
insert into public.contracts (id, type, counterparty, template, status, items)
values ('40000000-0000-0000-0000-000000000003', 'purchase', 'Ewa', 'purchase_v1', 'accepted', '[{"title": "Yeezy", "option": "43", "price": 500, "qty": 1}]');
do $$ begin
  perform public.finalize_contract('40000000-0000-0000-0000-000000000003');
  raise exception 'bez produktu powinno być zablokowane';
exception when others then
  if sqlerrm like 'bez produktu%' then raise; end if;
  raise notice 'OK: %', sqlerrm;
end $$;
-- kategorie: Jan (sztuka sprzedana, przyjęta) i Ola → do opłaty; Ewa bez sztuk → do opłaty; po opłaceniu → gotowe
update public.contracts set paid_at = now() where counterparty = 'Ola';
insert into public.contracts (type, counterparty, template, status) values ('purchase', 'Ula', 'purchase_v1', 'signed');
select counterparty, category, units_in_transit from public.contract_overview order by counterparty;
rollback;
