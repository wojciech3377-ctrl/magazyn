-- 0079: Sklep-kopia – produkty źródła spoza magazynu (np. Rope z Wykluczeń, usługi).
-- Nie ma ich w Katalogu aplikacji (bez sztuk), ale w kopii mają być 1:1 jak w sklepie źródłowym.
-- Tu: który produkt kopii odpowiada któremu produktowi źródła (po ID Shopify) i ostatnio wysłana wersja.
-- Można uruchomić kilka razy.

create table if not exists public.mirror_extra (
  store_id uuid not null references public.stores(id) on delete cascade,  -- sklep-kopia
  source_product_id text not null,                                         -- produkt Shopify źródła (gid)
  source_handle text,
  source_updated_at timestamptz,
  title text,
  mirror_product_id text,                                                  -- produkt Shopify kopii (gid)
  mirror_hash text,
  mirror_media_hash text,
  mirrored_at timestamptz,
  attempts int not null default 0,
  last_error text,
  claimed_at timestamptz,
  primary key (store_id, source_product_id)
);
create index if not exists mirror_extra_mirror on public.mirror_extra (store_id, mirror_product_id);
alter table public.mirror_extra enable row level security;
drop policy if exists mirror_extra_staff_read on public.mirror_extra;
create policy mirror_extra_staff_read on public.mirror_extra for select to authenticated using (public.is_staff());
revoke all on public.mirror_extra from public, anon;
grant select on public.mirror_extra to authenticated;
grant all on public.mirror_extra to service_role;

-- Zajęcie produktu przez jeden przebieg naraz (automat / przycisk) – na 5 minut.
create or replace function public.mirror_extra_claim(p_store uuid, p_source text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update public.mirror_extra set claimed_at = now()
   where store_id = p_store and source_product_id = p_source and (claimed_at is null or claimed_at < now() - interval '5 minutes');
  return found;
end $$;
revoke all on function public.mirror_extra_claim(uuid, text) from public, anon, authenticated;
grant execute on function public.mirror_extra_claim(uuid, text) to service_role;

notify pgrst, 'reload schema';
