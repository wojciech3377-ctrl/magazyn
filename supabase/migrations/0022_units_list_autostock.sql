-- Magazyn: płaski widok sztuk (sortowanie i filtry po każdej kolumnie, cena w sklepie)
-- oraz automatyczne sztuki dla nowych stanów w Base.

create or replace view public.units_list
with (security_invoker = true) as
select
  u.id, u.number, u.code, u.status, u.owner_type, u.purchase_form, u.purchase_price, u.payout_amount, u.identifier, u.shelf,
  u.received_at, u.sold_at, u.contract_id, u.notes, u.variant_id, u.location_id, u.consignor_id,
  v.option, v.ean,
  p.id as product_id, p.title, p.style_sku, p.image_url,
  l.name as location_name, l.store_id,
  s.name as store_name,
  c.name as consignor_name,
  ct.type as contract_type, ct.counterparty as contract_counterparty,
  coalesce(
    (select vsl.price from public.variant_store_links vsl where vsl.variant_id = u.variant_id and vsl.store_id = l.store_id and vsl.price is not null limit 1),
    (select vsl.price from public.variant_store_links vsl where vsl.variant_id = u.variant_id and vsl.price is not null order by vsl.updated_at desc limit 1)
  ) as shop_price,
  coalesce(
    (select vsl.base_sku from public.variant_store_links vsl where vsl.variant_id = u.variant_id and vsl.store_id = l.store_id and vsl.base_sku is not null limit 1),
    (select vsl.base_sku from public.variant_store_links vsl where vsl.variant_id = u.variant_id and vsl.base_sku is not null limit 1)
  ) as base_sku
from public.units u
join public.variants v on v.id = u.variant_id
join public.products p on p.id = v.product_id
join public.locations l on l.id = u.location_id
join public.stores s on s.id = l.store_id
left join public.consignors c on c.id = u.consignor_id
left join public.contracts ct on ct.id = u.contract_id;

grant select on public.units_list to authenticated;

/*
 * Stany z Base → sztuki: dla każdego rozmiaru i magazynu, gdzie Base ma więcej sztuk niż aplikacja
 * (na stanie + rezerwacje), tworzy brakujące sztuki „bez umowy”. Mniej w Base niż w aplikacji – nic nie usuwa.
 * p_rows: [{variant_id, location_id, qty}] – stan z Base. Limit sztuk na jedno wywołanie (bezpiecznik).
 */
create or replace function public.reconcile_base_stock(p_rows jsonb, p_limit int default 300)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_created int := 0;
  v_variants int := 0;
begin
  if not exists (select 1 from public.sync_state where key = 'initial_stock_imported') then
    return jsonb_build_object('created', 0, 'note', 'czekam na wgranie stanów z Base');
  end if;

  drop table if exists tmp_base;
  drop table if exists tmp_missing;
  create temporary table tmp_base on commit drop as
  select (r->>'variant_id')::uuid as variant_id, (r->>'location_id')::uuid as location_id, sum((r->>'qty')::int) as qty
  from jsonb_array_elements(p_rows) r
  group by 1, 2;

  create temporary table tmp_missing on commit drop as
  select b.variant_id, b.location_id, b.qty - coalesce(cnt.n, 0) as missing
  from tmp_base b
  left join lateral (
    select count(*) as n from public.units u
    where u.variant_id = b.variant_id and u.location_id = b.location_id and u.status in ('in_stock', 'reserved')
  ) cnt on true
  where b.qty > coalesce(cnt.n, 0);

  select count(*) into v_variants from tmp_missing;
  if (select coalesce(sum(missing), 0) from tmp_missing) > p_limit then
    raise exception 'Base ma o % sztuk więcej niż aplikacja – to za dużo na automat, sprawdź powiązania magazynów', (select sum(missing) from tmp_missing);
  end if;

  with ins as (
    insert into public.units (variant_id, location_id, status, owner_type, purchase_form, notes)
    select m.variant_id, m.location_id, 'in_stock', 'own', 'vat_margin', 'automatycznie: nowy stan w Base'
    from tmp_missing m cross join generate_series(1, m.missing)
    returning id
  ), ev as (
    insert into public.unit_events (unit_id, type, data)
    select id, 'received', '{"source": "automatycznie ze stanu w Base"}'::jsonb from ins
    returning 1
  )
  select count(*) into v_created from ev;

  return jsonb_build_object('created', v_created, 'variants', v_variants);
end;
$$;
revoke all on function public.reconcile_base_stock(jsonb, int) from public, anon, authenticated;
