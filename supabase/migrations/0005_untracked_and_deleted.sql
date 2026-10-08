-- Produkty bez śledzenia stanu w Shopify i produkty usunięte ze sklepu znikają z magazynu.
-- Wklej całość w Supabase → SQL Editor → Run.

alter table public.variant_store_links
  add column if not exists inventory_tracked boolean not null default true;

-- Po pełnym imporcie sklepu: powiązania, których import nie odświeżył, to produkty usunięte w Shopify.
-- Produkt bez żadnego sklepu i bez sztuk jest usuwany; z historią sztuk zostaje.
create or replace function public.prune_store_catalog(p_store_id uuid, p_started_at timestamptz)
returns jsonb
language plpgsql
as $$
declare
  v_links int;
  v_products int;
begin
  delete from public.variant_store_links
  where store_id = p_store_id and updated_at < p_started_at;
  delete from public.product_store_links
  where store_id = p_store_id and updated_at < p_started_at;
  get diagnostics v_links = row_count;

  delete from public.products p
  where not exists (select 1 from public.product_store_links psl where psl.product_id = p.id)
    and not exists (select 1 from public.units u join public.variants v on v.id = u.variant_id where v.product_id = p.id)
    and not exists (select 1 from public.sales s join public.variants v on v.id = s.variant_id where v.product_id = p.id);
  get diagnostics v_products = row_count;

  return jsonb_build_object('removed_links', v_links, 'removed_products', v_products);
end;
$$;

-- Wykluczone są też produkty, których żaden rozmiar nie ma śledzenia stanu w Shopify (usługi).
create or replace function public.excluded_product_ids()
returns table (product_id uuid)
language sql
stable
as $$
  select distinct p.id
  from public.products p
  left join public.variants v on v.product_id = p.id
  left join public.variant_store_links l on l.variant_id = v.id
  join public.catalog_exclusions e on
    (e.kind = 'sku_prefix' and (
        p.style_sku ilike replace(replace(e.value, '%', '\%'), '_', '\_') || '%'
     or l.sku ilike replace(replace(e.value, '%', '\%'), '_', '\_') || '%'
     or l.base_sku ilike replace(replace(e.value, '%', '\%'), '_', '\_') || '%'))
    or (e.kind = 'title_contains' and p.title ilike '%' || replace(replace(e.value, '%', '\%'), '_', '\_') || '%')
  union
  select v.product_id
  from public.variants v
  join public.variant_store_links l on l.variant_id = v.id
  group by v.product_id
  having bool_and(not l.inventory_tracked);
$$;
