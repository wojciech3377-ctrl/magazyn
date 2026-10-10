-- Stan magazynu wyłącznie ze Shopify: brakujące sztuki dochodzą, nadmiarowe (bez historii) znikają.
-- Base tylko uzupełnia SKU. Produkty spoza Shopify można usunąć z magazynu (z podglądem).

/*
 * Sztuka „bez historii”: własna, na stanie, bez umowy, bez dostawy, nigdy niesprzedana (sprzedaż, kasa, faktura).
 * Tylko takie sztuki automat może usunąć.
 */
create or replace function public.unit_is_plain(u public.units)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select u.owner_type = 'own' and u.contract_id is null and u.delivery_id is null
     and not exists (select 1 from public.sales s where s.unit_id = u.id)
     and not exists (select 1 from public.pos_order_items p where p.unit_id = u.id)
     and not exists (select 1 from public.invoice_items i where i.unit_id = u.id)
$$;
revoke all on function public.unit_is_plain(public.units) from public, anon, authenticated;

/*
 * Stan ze źródła → sztuki. p_rows: [{variant_id, location_id, qty, count_locations?}] (także qty = 0).
 *  - więcej w źródle: brakujące sztuki „bez umowy” (zupełnie nowy produkt od razu, inaczej po p_confirm_minutes),
 *  - mniej w źródle (p_remove): po p_surplus_minutes usuwa nadmiarowe sztuki bez historii (najnowsze najpierw);
 *    sztuk z umową / sprzedażą / dostawą nie rusza – zostają w wyniku jako „kept”.
 * Rozmiary z ruchem w aplikacji w ostatnich 30 min są pomijane.
 */
drop function if exists public.reconcile_stock(jsonb, int, text, uuid[], int);
create or replace function public.reconcile_stock(
  p_rows jsonb, p_limit int default 300, p_source text default 'Shopify', p_scope uuid[] default null,
  p_confirm_minutes int default 10, p_remove boolean default false, p_surplus_minutes int default 30
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_created int := 0;
  v_variants int := 0;
  v_waiting int := 0;
  v_removed int := 0;
  v_kept int := 0;
begin
  if not exists (select 1 from public.sync_state where key = 'initial_stock_imported') then
    return jsonb_build_object('created', 0, 'note', 'czekam na wgranie stanów początkowych');
  end if;

  drop table if exists tmp_src;
  drop table if exists tmp_diff;
  drop table if exists tmp_create;
  drop table if exists tmp_remove;
  create temporary table tmp_src on commit drop as
  select distinct on (variant_id, location_id) variant_id, location_id, qty, count_locs
  from (
    select (r->>'variant_id')::uuid as variant_id, (r->>'location_id')::uuid as location_id, greatest((r->>'qty')::int, 0) as qty,
           coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(r->'count_locations') x), array[(r->>'location_id')::uuid]) as count_locs
    from jsonb_array_elements(p_rows) r
  ) q
  order by variant_id, location_id, qty desc;

  -- diff > 0: brakuje w aplikacji; diff < 0: nadmiar w aplikacji (liczone sztuki na stanie).
  create temporary table tmp_diff on commit drop as
  select b.variant_id, b.location_id, b.count_locs,
         case when b.qty > c.have then b.qty - c.have
              when c.in_stock > b.qty then b.qty - c.in_stock
              else 0 end as diff
  from tmp_src b
  cross join lateral (
    select count(*) filter (where u.status in ('in_stock', 'reserved')) as have,
           count(*) filter (where u.status = 'in_stock') as in_stock
    from public.units u where u.variant_id = b.variant_id and u.location_id = any(b.count_locs)
  ) c
  where not exists (
    select 1 from public.unit_events e join public.units u on u.id = e.unit_id
    where u.variant_id = b.variant_id and e.created_at > now() - interval '30 minutes'
  );
  delete from tmp_diff where diff = 0 or (diff < 0 and not p_remove);

  if p_scope is not null then
    delete from public.stock_excess x
    where x.location_id = any(p_scope)
      and not exists (select 1 from tmp_diff d where d.variant_id = x.variant_id and d.location_id = x.location_id);
  end if;
  insert into public.stock_excess (variant_id, location_id, missing, source)
  select variant_id, location_id, diff, p_source from tmp_diff
  on conflict (variant_id, location_id) do update
    set missing = excluded.missing, source = excluded.source, last_seen_at = now(),
        first_seen_at = case when sign(public.stock_excess.missing) <> sign(excluded.missing) then now() else public.stock_excess.first_seen_at end;

  create temporary table tmp_create on commit drop as
  select d.variant_id, d.location_id, d.diff as missing
  from tmp_diff d
  join public.stock_excess x on x.variant_id = d.variant_id and x.location_id = d.location_id
  where d.diff > 0
    and (not exists (select 1 from public.units u where u.variant_id = d.variant_id)
         or x.first_seen_at <= now() - make_interval(mins => greatest(p_confirm_minutes, 0)));

  create temporary table tmp_remove on commit drop as
  select d.variant_id, d.location_id, d.count_locs, -d.diff as surplus
  from tmp_diff d
  join public.stock_excess x on x.variant_id = d.variant_id and x.location_id = d.location_id
  where d.diff < 0 and x.first_seen_at <= now() - make_interval(mins => greatest(p_surplus_minutes, 0));

  select count(*) into v_variants from tmp_create;
  select count(*) - v_variants into v_waiting from tmp_diff where diff > 0;
  if (select coalesce(sum(missing), 0) from tmp_create) > p_limit then
    raise exception '% ma o % sztuk więcej niż aplikacja – to za dużo na automat, sprawdź powiązania magazynów',
      p_source, (select sum(missing) from tmp_create);
  end if;
  -- Usuwanie ostrożniej niż dodawanie: duża różnica zwykle oznacza złe powiązanie lokalizacji.
  if (select coalesce(sum(surplus), 0) from tmp_remove) > least(p_limit, 150) then
    raise exception '% ma o % sztuk mniej niż aplikacja – to za dużo na automat, sprawdź powiązania magazynów',
      p_source, (select sum(surplus) from tmp_remove);
  end if;

  with ins as (
    insert into public.units (variant_id, location_id, status, owner_type, purchase_form, notes)
    select m.variant_id, m.location_id, 'in_stock', 'own', 'vat_margin', 'automatycznie: nowy stan w ' || p_source
    from tmp_create m cross join generate_series(1, m.missing)
    returning id
  ), ev as (
    insert into public.unit_events (unit_id, type, data)
    select id, 'received', jsonb_build_object('source', 'automatycznie ze stanu w ' || p_source) from ins
    returning 1
  )
  select count(*) into v_created from ev;

  with cand as (
    select u.id, row_number() over (partition by r.variant_id, r.location_id order by u.received_at desc, u.number desc) as rn, r.surplus
    from tmp_remove r
    join public.units u on u.variant_id = r.variant_id and u.location_id = any(r.count_locs) and u.status = 'in_stock'
    where public.unit_is_plain(u)
  ), del as (
    delete from public.units where id in (select id from cand where rn <= surplus) returning 1
  )
  select count(*) into v_removed from del;
  select coalesce(sum(surplus), 0) - v_removed into v_kept from tmp_remove;

  delete from public.stock_excess x using tmp_create c where x.variant_id = c.variant_id and x.location_id = c.location_id;
  delete from public.stock_excess x using tmp_remove c where x.variant_id = c.variant_id and x.location_id = c.location_id;

  return jsonb_build_object('created', v_created, 'variants', v_variants, 'waiting', v_waiting, 'removed', v_removed, 'kept', v_kept);
end;
$$;
revoke all on function public.reconcile_stock(jsonb, int, text, uuid[], int, boolean, int) from public, anon, authenticated;

create or replace function public.reconcile_base_stock(p_rows jsonb, p_limit int default 300)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select public.reconcile_stock(p_rows, p_limit, 'Base',
    (select array_agg(distinct (r->>'location_id')::uuid) from jsonb_array_elements(p_rows) r))
$$;
revoke all on function public.reconcile_base_stock(jsonb, int) from public, anon, authenticated;

/*
 * Produkty spoza Shopify (rozmiar bez powiązania z wariantem w żadnym sklepie Shopify) – usunięcie z magazynu.
 * Usuwa sztuki bez historii; sztuki komisowe, z umową, dostawą albo sprzedażą zostają (liczone jako „kept”).
 * Potem usuwa rozmiary i produkty, którym nic nie zostało. p_dry_run = tylko policz.
 */
create or replace function public.purge_non_shopify(p_dry_run boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_units int;
  v_kept int;
  v_variants int;
  v_products int;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'Tylko administrator może usuwać produkty z magazynu';
  end if;

  drop table if exists tmp_ns_variants;
  create temporary table tmp_ns_variants on commit drop as
  select v.id as variant_id, v.product_id
  from public.variants v
  where not exists (select 1 from public.variant_store_links l where l.variant_id = v.id and l.shopify_variant_id is not null);

  select count(*) filter (where u.status <> 'sold' and public.unit_is_plain(u)),
         count(*) filter (where not (u.status <> 'sold' and public.unit_is_plain(u)))
    into v_units, v_kept
  from public.units u join tmp_ns_variants t on t.variant_id = u.variant_id;

  if p_dry_run then
    select count(*) into v_variants from tmp_ns_variants t
     where not exists (select 1 from public.units u where u.variant_id = t.variant_id and not (u.status <> 'sold' and public.unit_is_plain(u)))
       and not exists (select 1 from public.sales s where s.variant_id = t.variant_id);
    return jsonb_build_object('units', v_units, 'kept', v_kept, 'variants', v_variants, 'dry_run', true);
  end if;

  delete from public.units u using tmp_ns_variants t
   where u.variant_id = t.variant_id and u.status <> 'sold' and public.unit_is_plain(u);
  get diagnostics v_units = row_count;

  delete from public.variants v using tmp_ns_variants t
   where v.id = t.variant_id
     and not exists (select 1 from public.units u where u.variant_id = v.id)
     and not exists (select 1 from public.sales s where s.variant_id = v.id);
  get diagnostics v_variants = row_count;

  delete from public.products p
   where not exists (select 1 from public.variants v where v.product_id = p.id)
     and p.id in (select product_id from tmp_ns_variants);
  get diagnostics v_products = row_count;

  return jsonb_build_object('units', v_units, 'kept', v_kept, 'variants', v_variants, 'products', v_products);
end;
$$;
revoke all on function public.purge_non_shopify(boolean) from public, anon;
grant execute on function public.purge_non_shopify(boolean) to authenticated;

-- PostgREST: nowe kolumny i funkcje widoczne od razu.
notify pgrst, 'reload schema';
