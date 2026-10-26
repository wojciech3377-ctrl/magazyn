-- 0080: Historia cen produktów spoza magazynu (np. Rope z Wykluczeń) – po rozmiarze Shopify sklepu źródłowego.
-- Produkty z magazynu mają historię w variant_price_history (SQL 30); tych nie ma w Katalogu, więc osobna tabela.
-- Z niej: najniższa cena z 30 dni pod ceną w sklepie-kopii (Owca Store). Można uruchomić kilka razy.

create table if not exists public.shop_price_history (
  id bigserial primary key,
  store_id uuid not null references public.stores(id) on delete cascade,
  shopify_variant_id text not null,
  price numeric(12,2) not null,
  compare_at_price numeric(12,2),
  valid_from timestamptz not null default now()
);
create index if not exists shop_price_history_idx on public.shop_price_history (store_id, shopify_variant_id, valid_from desc);
alter table public.shop_price_history enable row level security;
drop policy if exists shop_price_history_read on public.shop_price_history;
create policy shop_price_history_read on public.shop_price_history for select to authenticated using (public.is_staff());
revoke all on public.shop_price_history from public, anon;
grant select on public.shop_price_history to authenticated;
grant all on public.shop_price_history to service_role;
grant usage, select on sequence public.shop_price_history_id_seq to service_role;

notify pgrst, 'reload schema';
