-- JPK oparty na zamówieniach: numer zamówienia w Base (do paragonów z Base) zapisany przy zamówieniu.
alter table public.orders add column if not exists base_order_id bigint;
create index if not exists orders_base_order_idx on public.orders (base_order_id);

create or replace function public.link_sales_to_orders()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  update public.sales s
     set order_id = o.id
    from public.orders o
   where s.order_id is null
     and s.order_ref is not null
     and (s.store_id is null or s.store_id = o.store_id)
     and btrim(s.order_ref) in (o.number, o.name, o.shopify_legacy_id);
  get diagnostics n = row_count;

  update public.orders o
     set base_order_id = s.base_order_id
    from public.sales s
   where s.order_id = o.id and o.base_order_id is null;
  return n;
end;
$$;
revoke all on function public.link_sales_to_orders() from public, anon, authenticated;
select public.link_sales_to_orders();
