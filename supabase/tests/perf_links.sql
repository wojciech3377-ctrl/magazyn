\timing on
begin;
update public.stores set base_inventory_id = 500;
insert into public.products (id, title, style_sku)
select ('10000000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid, 'Model ' || g || ' Sneaker colorway', 'STY' || g from generate_series(1, 3000) g;
insert into public.product_store_links (product_id, store_id, shopify_product_id)
select ('10000000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid, s.id, 'gid://shopify/Product/' || g
from generate_series(1, 3000) g, public.stores s where s.code = 'sneakers-depot';
insert into public.variants (id, product_id, option)
select ('20000000-0000-0000-' || lpad(g::text, 4, '0') || '-' || lpad(z::text, 12, '0'))::uuid, ('10000000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid, (36 + z)::text
from generate_series(1, 3000) g, generate_series(1, 8) z;
insert into public.variant_store_links (variant_id, store_id, shopify_variant_id)
select v.id, s.id, 'gid://shopify/ProductVariant/' || (row_number() over ())
from public.variants v, public.stores s where s.code = 'sneakers-depot';
-- Base: 1600 produktów z 8 wariantami, połowa wariantów z powiązaniem
insert into public.base_products (inventory_id, id, parent_id, name, variant_name, sku, has_variants, links)
select 500, 100000 + g, 0, 'Model ' || g || ' Sneaker colorway', null, null, true, jsonb_build_object('shop_1', jsonb_build_object('product_id', g::text, 'variant_id', '0')) from generate_series(1, 1600) g;
insert into public.base_products (inventory_id, id, parent_id, name, variant_name, sku, has_variants, links)
select 500, 200000 + g * 10 + z, 100000 + g, 'Model ' || g || ' Sneaker colorway', (36 + z)::text, (g * 10 + z)::text, false,
  case when z % 2 = 0 then jsonb_build_object('shop_1', jsonb_build_object('product_id', g::text, 'variant_id', ((g - 1) * 8 + z)::text)) else '{}'::jsonb end
from generate_series(1, 1600) g, generate_series(1, 8) z;
analyze;
select public.apply_base_links((select id from public.stores where code = 'sneakers-depot'));
select public.suggest_base_links((select id from public.stores where code = 'sneakers-depot'), 200);
rollback;
