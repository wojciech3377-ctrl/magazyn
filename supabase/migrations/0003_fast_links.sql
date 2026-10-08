-- Szybsze łączenie z Base (duże katalogi mieściły się poza limitem czasu zapytania)
-- i podpowiedzi liczone w paczkach. Wklej całość w Supabase → SQL Editor → Run.

alter table public.variant_store_links
  add column if not exists suggest_checked_at timestamptz;

create index if not exists variant_store_links_store_idx on public.variant_store_links (store_id);
create index if not exists product_store_links_store_idx on public.product_store_links (store_id);
create index if not exists base_products_parent_name_gist on public.base_products using gist (name gist_trgm_ops) where parent_id = 0;
create index if not exists base_products_parent_idx on public.base_products (inventory_id, parent_id);

-- Powiązania z Base: wariant Base → wariant Shopify (oraz produkt bez wariantów → produkt z jednym rozmiarem).
-- Ręcznie przypisanych wariantów nie zmienia. Podpowiedzi liczy osobno suggest_base_links().
create or replace function public.apply_base_links(p_store_id uuid)
returns jsonb
language plpgsql
as $$
declare
  v_store public.stores%rowtype;
  v_linked int := 0;
  v_single int := 0;
  v_missing int := 0;
begin
  select * into v_store from public.stores where id = p_store_id;
  if v_store.base_inventory_id is null then
    raise exception 'Sklep % nie ma ustawionego katalogu Base', v_store.name;
  end if;

  -- Wszystkie powiązania sklepów z katalogu Base, rozpakowane raz.
  drop table if exists tmp_links;
  create temporary table tmp_links on commit drop as
  select bp.id as base_id, bp.parent_id, bp.sku, bp.has_variants,
         k.key as storage,
         k.value ->> 'product_id' as shop_product,
         nullif(nullif(k.value ->> 'variant_id', ''), '0') as shop_variant
  from public.base_products bp
  cross join lateral jsonb_each(bp.links) k
  where bp.inventory_id = v_store.base_inventory_id
    and bp.links <> '{}'::jsonb
    and k.key like 'shop\_%'
    and jsonb_typeof(k.value) = 'object';
  create index on tmp_links (storage, shop_variant);
  create index on tmp_links (storage, shop_product);
  analyze tmp_links;

  drop table if exists tmp_vsl;
  create temporary table tmp_vsl on commit drop as
  select vsl.id, vsl.variant_id, split_part(vsl.shopify_variant_id, '/', 5) as shop_variant, v.product_id
  from public.variant_store_links vsl
  join public.variants v on v.id = vsl.variant_id
  where vsl.store_id = p_store_id and vsl.base_link_source is distinct from 'manual';
  create index on tmp_vsl (shop_variant);
  analyze tmp_vsl;

  -- Który shop_XXXX w Base to ten sklep (po zgodnych ID produktów).
  if v_store.base_storage_id is null then
    select t.storage into v_store.base_storage_id
    from tmp_links t
    join public.product_store_links psl
      on psl.store_id = p_store_id and split_part(psl.shopify_product_id, '/', 5) = t.shop_product
    group by t.storage
    order by count(*) desc
    limit 1;
    if v_store.base_storage_id is not null then
      update public.stores set base_storage_id = v_store.base_storage_id where id = p_store_id;
    end if;
  end if;

  if v_store.base_storage_id is not null then
    -- 1. Wariant Base wskazuje dokładnie wariant Shopify.
    update public.variant_store_links vsl
    set base_product_id = m.base_id,
        base_parent_id = nullif(m.parent_id, 0),
        base_sku = m.sku,
        base_link_source = 'base',
        base_linked_at = now(),
        suggested_base_product_id = null,
        suggested_reason = null
    from (
      select distinct on (tv.id) tv.id, t.base_id, t.parent_id, t.sku
      from tmp_vsl tv
      join tmp_links t on t.storage = v_store.base_storage_id and t.shop_variant = tv.shop_variant
      where not t.has_variants
      order by tv.id, t.parent_id desc
    ) m
    where vsl.id = m.id;
    get diagnostics v_linked = row_count;

    -- 2. Produkt Base bez wariantów powiązany z produktem Shopify, który ma jeden rozmiar.
    update public.variant_store_links vsl
    set base_product_id = m.base_id,
        base_parent_id = null,
        base_sku = m.sku,
        base_link_source = 'base',
        base_linked_at = now(),
        suggested_base_product_id = null,
        suggested_reason = null
    from (
      select distinct on (one.vsl_id) one.vsl_id, t.base_id, t.sku
      from (
        select min(tv.id::text)::uuid as vsl_id, split_part(psl.shopify_product_id, '/', 5) as shop_product
        from tmp_vsl tv
        join public.product_store_links psl on psl.product_id = tv.product_id and psl.store_id = p_store_id
        group by psl.shopify_product_id
        having count(*) = 1
      ) one
      join tmp_links t
        on t.storage = v_store.base_storage_id and t.shop_product = one.shop_product
       and t.shop_variant is null and t.parent_id = 0 and not t.has_variants
      order by one.vsl_id, t.base_id
    ) m
    where vsl.id = m.vsl_id and vsl.base_product_id is null;
    get diagnostics v_single = row_count;
  end if;

  -- Podpowiedzi trzeba policzyć od nowa dla wszystkich niepowiązanych.
  update public.variant_store_links
  set suggest_checked_at = null
  where store_id = p_store_id and base_product_id is null;

  select count(*) into v_missing from public.variant_store_links
  where store_id = p_store_id and base_product_id is null;

  return jsonb_build_object('linked', v_linked + v_single, 'unlinked', v_missing,
                            'base_storage_id', v_store.base_storage_id);
end;
$$;

-- Podpowiedzi dla niepowiązanych rozmiarów, w paczkach (EAN, potem nazwa modelu + rozmiar).
-- Zwraca, ile zostało do sprawdzenia; aplikacja woła ją, aż dojdzie do zera.
create or replace function public.suggest_base_links(p_store_id uuid, p_limit int default 200)
returns jsonb
language plpgsql
as $$
declare
  v_inv bigint;
  v_done int;
  v_left int;
  v_suggested int;
begin
  select base_inventory_id into v_inv from public.stores where id = p_store_id;

  drop table if exists tmp_batch;
  create temporary table tmp_batch on commit drop as
  select vsl.id as link_id, v.ean, public.norm_option(v.option) as opt, p.title
  from public.variant_store_links vsl
  join public.variants v on v.id = vsl.variant_id
  join public.products p on p.id = v.product_id
  where vsl.store_id = p_store_id and vsl.base_product_id is null and vsl.suggest_checked_at is null
  limit p_limit;

  update public.variant_store_links vsl
  set suggested_base_product_id = null, suggested_reason = null
  from tmp_batch b
  where vsl.id = b.link_id;

  with by_ean as (
    select distinct on (b.link_id) b.link_id, bp.id as base_id, 'EAN ' || bp.ean as reason
    from tmp_batch b
    join public.base_products bp
      on bp.inventory_id = v_inv and coalesce(b.ean, '') <> '' and bp.ean = b.ean and not bp.has_variants
    order by b.link_id, bp.id
  ),
  -- Najpierw najbliższy produkt główny w Base dla każdego modelu (indeks trigramowy, KNN),
  -- potem rozmiar w jego wariantach. Szybkie także przy tysiącach podobnych nazw.
  best_parent as (
    select t.title, x.id as parent_id, x.has_variants, x.sim
    from (select distinct title from tmp_batch) t
    cross join lateral (
      select bp.id, bp.has_variants, similarity(t.title, bp.name) as sim
      from public.base_products bp
      where bp.inventory_id = v_inv and bp.parent_id = 0
      order by bp.name <-> t.title
      limit 1
    ) x
    where x.sim >= 0.45
  ),
  by_name as (
    select distinct on (b.link_id) b.link_id, coalesce(bv.id, bp0.id) as base_id,
           'nazwa ' || round(p.sim::numeric * 100) || '% + rozmiar' as reason
    from tmp_batch b
    join best_parent p on p.title = b.title
    left join public.base_products bv
      on p.has_variants and bv.inventory_id = v_inv and bv.parent_id = p.parent_id
     and public.norm_option(coalesce(bv.variant_name, '')) = b.opt
    left join public.base_products bp0
      on not p.has_variants and b.opt = '' and bp0.inventory_id = v_inv and bp0.id = p.parent_id
    where coalesce(bv.id, bp0.id) is not null
      and not exists (select 1 from by_ean e where e.link_id = b.link_id)
    order by b.link_id, bv.id
  ),
  picks as (select * from by_ean union all select * from by_name)
  update public.variant_store_links vsl
  set suggested_base_product_id = picks.base_id, suggested_reason = picks.reason
  from picks
  where vsl.id = picks.link_id;
  get diagnostics v_suggested = row_count;

  update public.variant_store_links vsl
  set suggest_checked_at = now()
  from tmp_batch b
  where vsl.id = b.link_id;
  get diagnostics v_done = row_count;

  select count(*) into v_left from public.variant_store_links
  where store_id = p_store_id and base_product_id is null and suggest_checked_at is null;

  return jsonb_build_object('checked', v_done, 'suggested', v_suggested, 'left', v_left);
end;
$$;

-- Zatwierdzenie wszystkich podpowiedzi jednego sklepu jednym zapytaniem.
create or replace function public.accept_base_suggestions(p_store_id uuid)
returns int
language plpgsql
as $$
declare
  v_count int;
begin
  update public.variant_store_links vsl
  set base_product_id = bp.id,
      base_parent_id = nullif(bp.parent_id, 0),
      base_sku = bp.sku,
      base_link_source = 'manual',
      base_linked_at = now(),
      suggested_base_product_id = null,
      suggested_reason = null
  from public.stores s, public.base_products bp
  where vsl.store_id = p_store_id
    and s.id = vsl.store_id
    and vsl.base_product_id is null
    and bp.inventory_id = s.base_inventory_id
    and bp.id = vsl.suggested_base_product_id
    and not bp.has_variants;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
