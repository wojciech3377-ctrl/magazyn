-- Test powiązań z Base i importu stanów.
\set ON_ERROR_STOP on
begin;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000001', 'szef@example.com');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);

update public.stores set base_inventory_id = 500;  -- oba sklepy w jednym katalogu Base
insert into public.locations (store_id, name, base_warehouse_id)
select id, 'Poznań – Długa 13', 'bl_1' from public.stores where code = 'sneakers-depot';
insert into public.locations (store_id, name, base_warehouse_id)
select id, 'Telefoniki – biuro', 'bl_1' from public.stores where code = 'telefoniki';

-- Produkt w Sneakers Depot (Shopify: jedno SKU modelu dla wszystkich rozmiarów)
insert into public.products (id, title, style_sku) values ('10000000-0000-0000-0000-000000000001', 'Yeezy Slide Onyx', 'HQ6448');
insert into public.product_store_links (product_id, store_id, shopify_product_id)
select '10000000-0000-0000-0000-000000000001', id, 'gid://shopify/Product/111' from public.stores where code = 'sneakers-depot';
insert into public.variants (id, product_id, option, ean) values
  ('20000000-0000-0000-0000-000000000039', '10000000-0000-0000-0000-000000000001', '39', null),
  ('20000000-0000-0000-0000-000000000040', '10000000-0000-0000-0000-000000000001', '40 2/3', null),
  ('20000000-0000-0000-0000-000000000042', '10000000-0000-0000-0000-000000000001', '42', '5901234567890');
insert into public.variant_store_links (variant_id, store_id, shopify_variant_id, sku)
select v, s.id, g, 'HQ6448' from public.stores s,
  (values ('20000000-0000-0000-0000-000000000039'::uuid, 'gid://shopify/ProductVariant/9039'),
          ('20000000-0000-0000-0000-000000000040'::uuid, 'gid://shopify/ProductVariant/9040'),
          ('20000000-0000-0000-0000-000000000042'::uuid, 'gid://shopify/ProductVariant/9042')) x(v, g)
where s.code = 'sneakers-depot';

-- Katalog Base: produkt główny z wariantami; SKU rozmiarów nadane po kolei, bez wzoru
reset role;
insert into public.base_products (inventory_id, id, parent_id, name, variant_name, sku, ean, has_variants, links, stock) values
  (500, 7000, 0, 'Adidas Yeezy Slide Onyx', null, 'BL-7000', null, true, '{"shop_2445": {"product_id": "111", "variant_id": "0"}}', '{}'),
  (500, 7001, 7000, 'Adidas Yeezy Slide Onyx', '39', '1532', null, false, '{"shop_2445": {"product_id": "111", "variant_id": "9039"}}', '{"bl_1": 2}'),
  (500, 7002, 7000, 'Adidas Yeezy Slide Onyx', 'EU 40 2/3', '1533', null, false, '{}', '{"bl_1": 1}'),
  (500, 7003, 7000, 'Adidas Yeezy Slide Onyx', '42', '1890', '5901234567890', false, '{}', '{"bl_1": 0}');
set local role authenticated;

select public.apply_base_links((select id from public.stores where code = 'sneakers-depot'));
select public.suggest_base_links((select id from public.stores where code = 'sneakers-depot'), 1);
select public.suggest_base_links((select id from public.stores where code = 'sneakers-depot'), 200);
select (select code from public.stores where id = vsl.store_id) as sklep, v.option, vsl.base_product_id, vsl.base_sku,
       vsl.base_link_source, vsl.suggested_base_product_id, vsl.suggested_reason
from public.variant_store_links vsl join public.variants v on v.id = vsl.variant_id order by v.option;
select code, base_storage_id from public.stores order by code;

-- zatwierdzenie podpowiedzi
select public.accept_base_suggestions((select id from public.stores where code = 'sneakers-depot')) as zatwierdzone;
select v.option, vsl.base_product_id, vsl.base_link_source from public.variant_store_links vsl
join public.variants v on v.id = vsl.variant_id order by v.option;

select public.preview_initial_stock();
select public.import_initial_stock();
select v.option, l.name, count(*) from public.units u join public.variants v on v.id = u.variant_id
join public.locations l on l.id = u.location_id group by 1, 2 order by 1;

do $$ begin
  perform public.import_initial_stock();
  raise exception 'drugi import powinien być zablokowany';
exception when others then
  if sqlerrm like 'drugi import%' then raise; end if;
  raise notice 'OK, blokada: %', sqlerrm;
end $$;
rollback;
