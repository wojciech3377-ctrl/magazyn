-- 0053: indeksy pod najczęstsze wyszukiwania (szybsze strony przy rosnącej liczbie sztuk i zamówień).
-- Bezpieczne do ponownego uruchomienia. Nie zmieniają danych.

-- Skan w Kasie / Magazynie: kod sztuki z etykiety (S000123).
create index if not exists units_code_idx on public.units (code);
-- Lista magazynu (stan + sortowanie po dacie przyjęcia), liczniki „w drodze”, stany na metkach.
create index if not exists units_status_received_idx on public.units (status, received_at desc);
-- Profil komisanta: jego rzeczy.
create index if not exists units_consignor_idx on public.units (consignor_id) where consignor_id is not null;

-- Zamówienia: przełącznik sklepu i liczniki zakładek.
create index if not exists orders_store_ordered_idx on public.orders (store_id, ordered_at desc);
create index if not exists orders_store_status_idx on public.orders (store_id, status);

-- Sprzedaż: linie po sztuce / rozmiarze, umowy linii, paragony zadań drukarki.
create index if not exists sales_unit_idx on public.sales (unit_id) where unit_id is not null;
create index if not exists sales_variant_idx on public.sales (variant_id) where variant_id is not null;
create index if not exists contracts_sale_idx on public.contracts (sale_id) where sale_id is not null;
create index if not exists contracts_status_idx on public.contracts (status);
create index if not exists receipts_job_idx on public.receipts (job_id) where job_id is not null;

-- Katalog: pozycje zamówień ze Shopify → rozmiar w magazynie, produkty sklepu, EAN, SKU modelu.
create index if not exists variant_store_links_shopify_variant_idx on public.variant_store_links (shopify_variant_id);
create index if not exists product_store_links_product_idx on public.product_store_links (product_id);
create index if not exists variants_ean_idx on public.variants (ean) where ean is not null;
create index if not exists products_style_sku_plain_idx on public.products (style_sku) where style_sku is not null;
-- Wyszukiwanie po SKU (także fragmencie) w Kasie i Magazynie.
create index if not exists variant_store_links_sku_trgm_idx on public.variant_store_links using gin (sku gin_trgm_ops);
create index if not exists variant_store_links_base_sku_trgm_idx on public.variant_store_links using gin (base_sku gin_trgm_ops);

-- WTB po produkcie, dziennik synchronizacji (ostatnie wpisy danego zadania).
create index if not exists wtb_items_product_idx on public.wtb_items (product_id) where product_id is not null;
create index if not exists sync_log_job_created_idx on public.sync_log (job, created_at desc);

analyze public.units, public.orders, public.sales, public.contracts, public.variant_store_links, public.product_store_links, public.variants, public.products;
