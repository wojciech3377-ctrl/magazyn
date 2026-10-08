-- Wykluczenia działają też na pojedyncze rozmiary/warianty, np. „Wymiana ekranu” + wariant „iPhone 17 (oryginał)”.
-- Reguła „nazwa zawiera” sprawdza nazwę produktu oraz nazwę produktu razem z nazwą wariantu.
-- Wklej całość w Supabase → SQL Editor → Run.

create or replace function public.excluded_variant_ids()
returns table (variant_id uuid)
language sql
stable
as $$
  with rules as (
    select kind, replace(replace(trim(value), '%', '\%'), '_', '\_') as v from public.catalog_exclusions
  )
  select distinct v.id
  from public.variants v
  join public.products p on p.id = v.product_id
  left join public.variant_store_links l on l.variant_id = v.id
  join rules e on
    (e.kind = 'sku_prefix' and (p.style_sku ilike e.v || '%' or l.sku ilike e.v || '%' or l.base_sku ilike e.v || '%'))
    or (e.kind = 'title_contains' and (p.title ilike '%' || e.v || '%' or (p.title || ' ' || v.option) ilike '%' || e.v || '%'
                                       or v.option ilike '%' || e.v || '%'))
  union
  -- rozmiary bez śledzenia stanu w żadnym sklepie (usługi)
  select l.variant_id
  from public.variant_store_links l
  group by l.variant_id
  having bool_and(not l.inventory_tracked);
$$;

create or replace function public.excluded_product_ids()
returns table (product_id uuid)
language sql
stable
as $$
  -- produkty, których wszystkie warianty są wykluczone
  select v.product_id
  from public.variants v
  left join public.excluded_variant_ids() x on x.variant_id = v.id
  group by v.product_id
  having bool_and(x.variant_id is not null);
$$;

create or replace function public.purge_excluded()
returns jsonb
language plpgsql
as $$
declare
  v_units int;
  v_variants int;
  v_products int;
begin
  if not public.is_admin() and auth.uid() is not null then
    raise exception 'Tylko administrator może usuwać wykluczone produkty';
  end if;

  drop table if exists tmp_excluded_variants;
  create temporary table tmp_excluded_variants on commit drop as select variant_id from public.excluded_variant_ids();

  delete from public.sales where variant_id in (select variant_id from tmp_excluded_variants);
  delete from public.units where variant_id in (select variant_id from tmp_excluded_variants);
  get diagnostics v_units = row_count;
  delete from public.variants where id in (select variant_id from tmp_excluded_variants);
  get diagnostics v_variants = row_count;

  -- produkty, którym nie został żaden rozmiar
  delete from public.products p where not exists (select 1 from public.variants v where v.product_id = p.id);
  get diagnostics v_products = row_count;

  return jsonb_build_object('units', v_units, 'variants', v_variants, 'products', v_products);
end;
$$;
