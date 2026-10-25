-- 0078: Sklep-kopia (np. Owca Store): te same produkty co sklep źródłowy (Sneakers Depot), te same sztuki.
-- • Produkty: aplikacja tworzy i aktualizuje w kopii produkty ze sklepu źródłowego (tytuł, opis, zdjęcia, rozmiary, ceny,
--   tagi, status). Kolejka mirror_queue – co jest do utworzenia / zaktualizowania.
-- • Stany: liczone ze sztuk w lokalizacjach sklepu źródłowego (kopia nie ma własnych lokalizacji w aplikacji),
--   wysyłane do jednej lokalizacji Shopify kopii (stores.mirror_location_id).
-- • Zamówienia z kopii zdejmują te same sztuki co zamówienia ze sklepu źródłowego.
-- Można uruchomić kilka razy.

alter table public.stores add column if not exists mirror_of uuid references public.stores(id) on delete set null;
alter table public.stores add column if not exists mirror_location_id text;
alter table public.stores drop constraint if exists stores_mirror_not_self;
alter table public.stores add constraint stores_mirror_not_self check (mirror_of is null or mirror_of <> id);

-- Ostatnio wysłana wersja produktu do kopii (bez zmian w źródle – bez zapisu w Shopify).
alter table public.product_store_links add column if not exists mirror_hash text;
alter table public.product_store_links add column if not exists mirror_media_hash text;
alter table public.product_store_links add column if not exists mirrored_at timestamptz;

create table if not exists public.mirror_queue (
  store_id uuid not null references public.stores(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  queued_at timestamptz not null default now(),
  attempts int not null default 0,
  last_error text,
  primary key (store_id, product_id)
);
create index if not exists mirror_queue_order on public.mirror_queue (store_id, attempts, queued_at);
alter table public.mirror_queue enable row level security;
drop policy if exists mirror_queue_staff_read on public.mirror_queue;
create policy mirror_queue_staff_read on public.mirror_queue for select to authenticated using (public.is_staff());
revoke all on public.mirror_queue from public, anon;
grant select on public.mirror_queue to authenticated;
grant all on public.mirror_queue to service_role;

-- Sklep Owca Store jako kopia Sneakers Depot (domenę Shopify ustawiasz w Ustawieniach → Sklepy i lokalizacje).
insert into public.stores (code, name, mirror_of)
select 'owca-store', 'Owca Store', s.id from public.stores s
where s.name ilike '%sneakers%' and not exists (select 1 from public.stores where code = 'owca-store')
order by s.created_at limit 1;

notify pgrst, 'reload schema';
