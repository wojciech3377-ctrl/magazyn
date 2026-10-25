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

-- Jeden produkt kopii na produkt aplikacji (wiersze kopii mają mirror_hash) – bez duplikatów przy równoczesnych przebiegach.
do $$ begin
  create unique index if not exists product_store_links_mirror_one on public.product_store_links (store_id, product_id) where mirror_hash is not null;
exception when unique_violation then raise notice 'Duplikaty produktów kopii – usuń je przed ponownym uruchomieniem: %', sqlerrm;
end $$;
-- Zajęcie produktu przez jeden przebieg kopii naraz (webhook, automat, przycisk) – na 5 minut.
alter table public.mirror_queue add column if not exists claimed_at timestamptz;
create or replace function public.mirror_claim(p_store uuid, p_product uuid) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  insert into public.mirror_queue (store_id, product_id) values (p_store, p_product) on conflict do nothing;
  update public.mirror_queue set claimed_at = now()
   where store_id = p_store and product_id = p_product and (claimed_at is null or claimed_at < now() - interval '5 minutes');
  return found;
end $$;
revoke all on function public.mirror_claim(uuid, uuid) from public, anon, authenticated;
grant execute on function public.mirror_claim(uuid, uuid) to service_role;

-- Sztuka do zamówienia: ze sklepu zamówienia; zamówienie ze sklepu-kopii – tylko ze sztuk sklepu źródłowego
-- (lokalizacje z przypisaną lokalizacją Shopify), nie z innego sklepu.
create or replace function public.pick_unit_for_sale(p_variant_id uuid, p_store_id uuid default null)
returns uuid
language sql
as $$
  with s as (
    select coalesce((select st.mirror_of from public.stores st where st.id = p_store_id), p_store_id) as sid,
           exists (select 1 from public.stores st where st.id = p_store_id and st.mirror_of is not null) as mirror
  )
  select u.id
  from public.units u
  join public.locations l on l.id = u.location_id
  cross join s
  where u.variant_id = p_variant_id
    and u.status = 'in_stock'
    and (not s.mirror or (l.store_id = s.sid and l.active and l.shopify_location_id is not null))
  order by
    (s.sid is not null and l.store_id = s.sid) desc,
    (u.owner_type = 'consignment') asc,
    u.received_at asc,
    u.number asc
  limit 1
  for update of u skip locked;
$$;

-- Sklep Owca Store jako kopia Sneakers Depot (domenę Shopify ustawiasz w Ustawieniach → Sklepy i lokalizacje).
insert into public.stores (code, name, mirror_of)
select 'owca-store', 'Owca Store', s.id from public.stores s
where s.name ilike '%sneakers%' and not exists (select 1 from public.stores where code = 'owca-store')
order by s.created_at limit 1;

notify pgrst, 'reload schema';
