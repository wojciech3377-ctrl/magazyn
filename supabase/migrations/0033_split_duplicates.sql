-- Osobne produkty Shopify z tym samym SKU w jednym sklepie (np. każda używana para jako osobny produkt) były
-- łączone w jeden produkt aplikacji, więc stan liczył się raz zamiast dla każdej rzeczy. Ta funkcja wskazuje takie
-- połączenia; aplikacja rozdziela je automatycznie (przy odczycie katalogu co 15 minut).
create or replace function public.duplicate_store_products(p_limit int default 50)
returns table (store_id uuid, product_id uuid, shopify_product_ids text[])
language sql
stable
security definer
set search_path = public
as $$
  select l.store_id, l.product_id, array_agg(l.shopify_product_id order by length(l.shopify_product_id), l.shopify_product_id)
  from public.product_store_links l
  group by l.store_id, l.product_id
  having count(*) > 1
  limit greatest(p_limit, 1)
$$;
revoke all on function public.duplicate_store_products(int) from public, anon, authenticated;

notify pgrst, 'reload schema';
