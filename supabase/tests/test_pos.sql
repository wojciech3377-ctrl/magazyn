-- Test sprzedaży stacjonarnej.
\set ON_ERROR_STOP on
begin;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000001', 'szef@example.com');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
insert into public.locations (store_id, name) select id, 'Sklep' from public.stores where code = 'sneakers-depot';
insert into public.products (id, title) values ('10000000-0000-0000-0000-000000000001', 'Dunk');
insert into public.variants (id, product_id, option) values ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '42');
select public.receive_delivery((select id from public.stores where code = 'sneakers-depot'), (select id from public.locations limit 1),
  '20000000-0000-0000-0000-000000000001', 2);
select public.create_pos_order((select id from public.stores where code = 'sneakers-depot'),
  (select jsonb_agg(jsonb_build_object('unit_id', id, 'price', 499.5)) from public.units), 'cash', 'Jan', null);
select code, total, payment_method from public.pos_orders;
select code, status from public.units order by number;
do $$ begin
  perform public.create_pos_order((select id from public.stores where code = 'sneakers-depot'),
    (select jsonb_agg(jsonb_build_object('unit_id', id, 'price', 1)) from public.units), 'cash', null, null);
  raise exception 'drugi raz nie powinno przejść';
exception when others then
  if sqlerrm like 'drugi raz%' then raise; end if;
  raise notice 'OK, blokada: %', sqlerrm;
end $$;
select public.return_unit((select id from public.units order by number limit 1), true);
select status from public.pos_order_items order by status;
rollback;
