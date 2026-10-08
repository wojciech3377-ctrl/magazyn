begin;
with svc as (
  select distinct v.product_id
  from public.variants v
  left join public.variant_store_links l on l.variant_id = v.id
  left join public.products p on p.id = v.product_id
  where p.style_sku ilike any (array['TF-SRV%', 'TF-OCHR%'])
     or l.sku ilike any (array['TF-SRV%', 'TF-OCHR%'])
     or l.base_sku ilike any (array['TF-SRV%', 'TF-OCHR%'])
),
svc_variants as (
  select id from public.variants where product_id in (select product_id from svc)
),
del_sales as (
  delete from public.sales where variant_id in (select id from svc_variants) returning 1
),
del_units as (
  delete from public.units where variant_id in (select id from svc_variants) returning 1
)
select (select count(*) from del_units) as usuniete_sztuki, (select count(*) from del_sales) as usuniete_sprzedaze;

delete from public.products p
where exists (
  select 1 from public.variants v
  left join public.variant_store_links l on l.variant_id = v.id
  where v.product_id = p.id
    and (p.style_sku ilike any (array['TF-SRV%', 'TF-OCHR%'])
         or l.sku ilike any (array['TF-SRV%', 'TF-OCHR%'])
         or l.base_sku ilike any (array['TF-SRV%', 'TF-OCHR%']))
)
and not exists (select 1 from public.units u join public.variants v on v.id = u.variant_id where v.product_id = p.id);
commit;
