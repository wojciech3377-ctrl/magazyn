-- Zamówienie zarchiwizowane w Shopify = dostarczone. Ponowny odczyt ostatnich 45 dni, żeby uzupełnić datę archiwizacji.
alter table public.orders add column if not exists closed_at timestamptz;
delete from public.sync_state where key like 'shopify_orders:%';
