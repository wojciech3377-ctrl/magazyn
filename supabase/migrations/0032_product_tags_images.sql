-- Tagi produktu ze Shopify (np. „reused” = rzecz używana → metka na naklejce w drugim kolorze)
-- i zdjęcia produktu ze Shopify (galeria w karcie sztuki; odświeżane przy otwarciu, raz na dobę).
alter table public.product_store_links add column if not exists tags text[] not null default '{}';
alter table public.product_store_links add column if not exists images jsonb;
alter table public.product_store_links add column if not exists images_at timestamptz;

-- Ponowny odczyt katalogu ze Shopify (porcjami w automacie), żeby uzupełnić tagi.
delete from public.sync_state where key like 'shopify_products:%';

notify pgrst, 'reload schema';
