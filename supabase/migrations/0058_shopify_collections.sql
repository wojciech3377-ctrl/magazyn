-- 0058: kolekcje (kategorie) ze Shopify – filtr „Kategorie” w Magazynie (można wybrać kilka naraz).
-- Aplikacja co kilka godzin (i przy „Sprawdź nowe produkty i stany”) pobiera kolekcje każdego sklepu z listą produktów.
-- products.collections = nazwy kolekcji produktu ze wszystkich sklepów (odświeżane po pobraniu).

create table if not exists public.shop_collections (
  store_id uuid not null references public.stores(id) on delete cascade,
  gid text not null,
  title text not null,
  handle text,
  products_count integer not null default 0,
  synced_at timestamptz,
  primary key (store_id, gid)
);

create table if not exists public.shop_collection_products (
  store_id uuid not null,
  collection_gid text not null,
  shopify_product_id text not null,
  primary key (store_id, collection_gid, shopify_product_id),
  foreign key (store_id, collection_gid) references public.shop_collections(store_id, gid) on delete cascade
);
create index if not exists shop_collection_products_product_idx on public.shop_collection_products (store_id, shopify_product_id);

alter table public.shop_collections enable row level security;
alter table public.shop_collection_products enable row level security;
drop policy if exists shop_collections_staff_read on public.shop_collections;
create policy shop_collections_staff_read on public.shop_collections for select to authenticated using (public.is_staff());
drop policy if exists shop_collection_products_staff_read on public.shop_collection_products;
create policy shop_collection_products_staff_read on public.shop_collection_products for select to authenticated using (public.is_staff());
revoke insert, update, delete on public.shop_collections, public.shop_collection_products from anon, authenticated;
revoke all on public.shop_collections, public.shop_collection_products from anon;

alter table public.products add column if not exists collections text[] not null default '{}';
create index if not exists products_collections_idx on public.products using gin (collections);

-- Przeliczenie products.collections z pobranych kolekcji (wywołuje serwer aplikacji po synchronizacji).
create or replace function public.refresh_product_collections() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  with agg as (
    select l.product_id, array_agg(distinct c.title order by c.title) as cols
    from public.product_store_links l
    join public.shop_collection_products cp on cp.store_id = l.store_id and cp.shopify_product_id = l.shopify_product_id
    join public.shop_collections c on c.store_id = cp.store_id and c.gid = cp.collection_gid
    group by l.product_id
  )
  update public.products p set collections = coalesce(a.cols, '{}')
  from public.products p2 left join agg a on a.product_id = p2.id
  where p.id = p2.id and p.collections is distinct from coalesce(a.cols, '{}');
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.refresh_product_collections() from public, anon, authenticated;

-- Pole wyliczane do filtra listy sztuk: units_list?collections=ov.{…}
create or replace function public.collections(public.units_list) returns text[]
language sql stable set search_path = public as $$
  select p.collections from public.products p where p.id = $1.product_id
$$;
grant execute on function public.collections(public.units_list) to authenticated;

notify pgrst, 'reload schema';
