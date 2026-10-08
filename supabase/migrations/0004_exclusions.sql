-- Wykluczenia z magazynu (usługi, mystery boxy itp.), edytowalne w Ustawieniach.
-- Wklej całość w Supabase → SQL Editor → Run.

create table if not exists public.catalog_exclusions (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('sku_prefix', 'title_contains')),
  value text not null check (length(trim(value)) >= 2),
  created_at timestamptz not null default now(),
  unique (kind, value)
);

alter table public.catalog_exclusions enable row level security;
drop policy if exists catalog_exclusions_read on public.catalog_exclusions;
create policy catalog_exclusions_read on public.catalog_exclusions for select to authenticated using (public.is_staff());
drop policy if exists catalog_exclusions_admin on public.catalog_exclusions;
create policy catalog_exclusions_admin on public.catalog_exclusions for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

insert into public.catalog_exclusions (kind, value) values
  ('sku_prefix', 'TF-SRV'),
  ('sku_prefix', 'TF-OCHR'),
  ('title_contains', 'mystery box'),
  ('title_contains', 'Wymiana ekranu iPhone 17 (oryginał)')
on conflict (kind, value) do nothing;

-- Produkty pasujące do wykluczeń (po SKU modelu, SKU wariantu ze sklepu, SKU z Base albo nazwie).
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
    or (e.kind = 'title_contains' and p.title ilike '%' || replace(replace(e.value, '%', '\%'), '_', '\_') || '%');
$$;

-- Usuwa z aplikacji wykluczone produkty razem z ich sztukami (stany w Base się nie zmieniają).
create or replace function public.purge_excluded()
returns jsonb
language plpgsql
as $$
declare
  v_units int;
  v_products int;
begin
  if not public.is_admin() and auth.uid() is not null then
    raise exception 'Tylko administrator może usuwać wykluczone produkty';
  end if;

  drop table if exists tmp_excluded;
  create temporary table tmp_excluded on commit drop as select product_id from public.excluded_product_ids();

  delete from public.sales s
  using public.variants v
  where s.variant_id = v.id and v.product_id in (select product_id from tmp_excluded);

  delete from public.units u
  using public.variants v
  where u.variant_id = v.id and v.product_id in (select product_id from tmp_excluded);
  get diagnostics v_units = row_count;

  delete from public.products where id in (select product_id from tmp_excluded);
  get diagnostics v_products = row_count;

  return jsonb_build_object('units', v_units, 'products', v_products);
end;
$$;
