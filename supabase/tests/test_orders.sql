-- Test zamówień Shopify: łączenie linii z Base, uprawnienia.
\set ON_ERROR_STOP on
begin;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000001', 'szef@example.com');
insert into public.orders (id, store_id, shopify_order_id, shopify_legacy_id, name, number, ordered_at)
select '30000000-0000-0000-0000-000000000001', id, 'gid://shopify/Order/555', '555', '#2932', '2932', now() from public.stores where code = 'sneakers-depot';
insert into public.orders (id, store_id, shopify_order_id, shopify_legacy_id, name, number, ordered_at)
select '30000000-0000-0000-0000-000000000002', id, 'gid://shopify/Order/777', '777', '#2932', '2932', now() from public.stores where code = 'telefoniki';
insert into public.sales (store_id, base_order_id, base_order_product_id, order_ref, status)
select id, 1, 1, '2932', 'no_unit' from public.stores where code = 'sneakers-depot';
insert into public.sales (store_id, base_order_id, base_order_product_id, order_ref, status)
select id, 2, 1, '777', 'no_unit' from public.stores where code = 'telefoniki';
insert into public.sales (store_id, base_order_id, base_order_product_id, order_ref, status)
select id, 3, 1, '9999', 'no_unit' from public.stores where code = 'telefoniki';
select public.link_sales_to_orders() as linked;
do $$ begin
  if (select order_id from public.sales where base_order_id = 1) <> '30000000-0000-0000-0000-000000000001' then raise exception 'zła para dla #2932'; end if;
  if (select order_id from public.sales where base_order_id = 2) <> '30000000-0000-0000-0000-000000000002' then raise exception 'zła para po ID Shopify'; end if;
  if (select order_id from public.sales where base_order_id = 3) is not null then raise exception 'nie powinno się połączyć'; end if;
end $$;
insert into public.shipments (order_id, external_id, tracking_number) values ('30000000-0000-0000-0000-000000000001', '269777037', '620999');
-- Zwykły pracownik czyta zamówienia i przesyłki, ale nie tokeny i nie zmienia zamówień.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
do $$ begin
  if (select count(*) from public.orders) <> 2 then raise exception 'pracownik nie widzi zamówień'; end if;
  if (select count(*) from public.shipments) <> 1 then raise exception 'pracownik nie widzi przesyłek'; end if;
  if (select count(*) from public.integration_tokens) <> 0 then raise exception 'tokeny widoczne'; end if;
  update public.orders set status = 'delivered';
  if (select count(*) from public.orders where status = 'delivered') <> 0 then raise exception 'pracownik zmienił zamówienie'; end if;
end $$;
do $$ begin
  perform public.link_sales_to_orders();
  raise exception 'pracownik nie powinien wołać funkcji';
exception when insufficient_privilege then raise notice 'OK, brak uprawnień do link_sales_to_orders';
end $$;
rollback;
-- WTB i status „Zwrócone”.
begin;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000001', 'szef@example.com');
insert into public.orders (id, store_id, shopify_order_id, name, number, ordered_at, status)
select '30000000-0000-0000-0000-000000000003', id, 'gid://shopify/Order/9', '#1', '1', now(), 'returned' from public.stores where code = 'sneakers-depot';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
insert into public.wtb_items (title, size, source, order_id, order_line_id) values ('Jordan 4', '42', 'order', '30000000-0000-0000-0000-000000000003', 'gid://shopify/LineItem/1');
do $$ begin
  insert into public.wtb_items (title, size, source, order_id, order_line_id) values ('Jordan 4', '42', 'order', '30000000-0000-0000-0000-000000000003', 'gid://shopify/LineItem/1');
  raise exception 'duplikat nie powinien przejść';
exception when unique_violation then raise notice 'OK, ta sama pozycja raz na liście';
end $$;
update public.wtb_items set status = 'bought';
insert into public.wtb_items (title, size, source, order_id, order_line_id) values ('Jordan 4', '42', 'order', '30000000-0000-0000-0000-000000000003', 'gid://shopify/LineItem/1');
select status, count(*) from public.wtb_items group by status order by status;
rollback;
-- Faktury: numeracja FVM/n/rok bez dziur.
begin;
select number from public.create_invoice('{"issue_date":"2026-10-09","seller":{},"buyer":{"name":"Jan"},"total_gross":100,"net_23":0,"vat_23":0,"margin_total":100}', '[{"name":"Buty","unit_price_gross":100,"total_gross":100,"vat":"margin"}]');
select number from public.create_invoice('{"issue_date":"2026-10-09","seller":{},"buyer":{"name":"Jan"},"total_gross":123,"net_23":100,"vat_23":23,"margin_total":0}', '[{"name":"Buty","unit_price_gross":123,"total_gross":123,"vat":"23"}]');
do $$ begin
  perform public.create_invoice('{"issue_date":"2026-10-09","seller":{},"buyer":{}}', '[]');
  raise exception 'pusta faktura nie powinna przejść';
exception when others then
  if sqlerrm like 'pusta%' then raise; end if;
  raise notice 'OK: %', sqlerrm;
end $$;
select number from public.create_invoice('{"issue_date":"2026-10-10","seller":{},"buyer":{"name":"Jan"},"total_gross":1,"net_23":0,"vat_23":0,"margin_total":1}', '[{"name":"X","unit_price_gross":1,"total_gross":1,"vat":"margin"}]');
select number, (select count(*) from public.invoice_items i where i.invoice_id = v.id) from public.invoices v order by seq;
rollback;
-- Umowa do sprzedanego przedmiotu bez sztuki.
begin;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000001', 'szef@example.com');
insert into public.locations (store_id, name) select id, 'Sklep' from public.stores where code = 'sneakers-depot';
insert into public.products (id, title) values ('10000000-0000-0000-0000-000000000009', 'Dunk');
insert into public.variants (id, product_id, option) values ('20000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000009', '42');
insert into public.sales (id, store_id, base_order_id, base_order_product_id, variant_id, status)
select '40000000-0000-0000-0000-000000000001', id, 77, 1, '20000000-0000-0000-0000-000000000009', 'no_unit' from public.stores where code = 'sneakers-depot';
insert into public.contracts (id, type, counterparty) values ('50000000-0000-0000-0000-000000000001', 'purchase', 'Jan');
select public.attach_sale_unit('40000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', 300) is not null as attached;
select s.status, u.status as unit_status, u.contract_id is not null as has_contract, u.purchase_price from public.sales s join public.units u on u.id = s.unit_id;
do $$ begin
  perform public.attach_sale_unit('40000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', 300);
  raise exception 'drugi raz nie powinno przejść';
exception when others then
  if sqlerrm like 'drugi raz%' then raise; end if;
  raise notice 'OK: %', sqlerrm;
end $$;
rollback;
