-- Produkty, które zniknęły ze Shopify: automatycznie usuwane z magazynu (sztuki bez historii),
-- a sztuki z umową / sprzedażą zostają z oznaczeniem „brak w Shopify”.

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
  sp.shop_price,
  coalesce(
    (select vsl.base_sku from public.variant_store_links vsl where vsl.variant_id = u.variant_id and vsl.store_id = l.store_id and vsl.base_sku is not null limit 1),
    (select vsl.base_sku from public.variant_store_links vsl where vsl.variant_id = u.variant_id and vsl.base_sku is not null limit 1)
  ) as base_sku,
  case
    when sp.shop_price is not null then null
    when not exists (select 1 from public.variant_store_links vsl where vsl.variant_id = u.variant_id and vsl.shopify_variant_id is not null)
      then 'Ten rozmiar nie jest powiązany z wariantem w Shopify – produktu nie ma w sklepie albo nie został jeszcze odczytany. Powiąż go w Katalogu.'
    else 'Shopify nie podał ceny tego wariantu – poczekaj na odczyt produktów (co 15 min) albo kliknij „Sprawdź nowe produkty i stany”.'
  end as shop_price_error,
  not exists (select 1 from public.variant_store_links vsl where vsl.variant_id = u.variant_id and vsl.shopify_variant_id is not null) as shop_missing
from public.units u
join public.variants v on v.id = u.variant_id
join public.products p on p.id = v.product_id
join public.locations l on l.id = u.location_id
join public.stores s on s.id = l.store_id
left join public.consignors c on c.id = u.consignor_id
left join public.contracts ct on ct.id = u.contract_id
left join lateral (
  select coalesce(
    (select vsl.price from public.variant_store_links vsl where vsl.variant_id = u.variant_id and vsl.store_id = l.store_id and vsl.price is not null limit 1),
    (select vsl.price from public.variant_store_links vsl where vsl.variant_id = u.variant_id and vsl.price is not null order by vsl.updated_at desc limit 1)
  ) as shop_price
) sp on true;
grant select on public.units_list to authenticated;


drop function if exists public.purge_non_shopify(boolean);
create or replace function public.purge_non_shopify(p_dry_run boolean default true, p_max int default null)
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

  if not p_dry_run and p_max is not null and v_units > p_max then
    raise exception 'Do usunięcia jest % sztuk spoza Shopify – automat usuwa najwyżej %, użyj przycisku w Ustawieniach → Stany magazynowe', v_units, p_max;
  end if;

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
revoke all on function public.purge_non_shopify(boolean, int) from public, anon;
grant execute on function public.purge_non_shopify(boolean, int) to authenticated;

notify pgrst, 'reload schema';
