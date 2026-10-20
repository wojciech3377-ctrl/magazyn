-- 0070: nazwa na paragonie przy regule wykluczenia (np. „Sznurówki Air Force 1 z Blaszką” → „Sznur”)
-- oraz zmiana nazwy / stawki VAT pozycji w konkretnym zamówieniu (paragon, paragon PDF, faktura).
-- Można uruchomić kilka razy.

alter table public.catalog_exclusions add column if not exists receipt_name text;
alter table public.orders add column if not exists line_overrides jsonb not null default '{}'::jsonb;

-- Sznurówki Air Force 1 z Blaszką → na paragonie „Sznur”. Osobna, dokładniejsza reguła (wygrywa z ogólną,
-- np. „sznurówki”); stawka jak w regule, która dziś obejmuje te sznurówki (bez takiej – VAT marża).
insert into public.catalog_exclusions (kind, value, vat, receipt_name)
select 'title_contains', 'Sznurówki Air Force 1 z Blaszką',
  coalesce((select e.vat from public.catalog_exclusions e
            where e.kind = 'title_contains' and position(lower(e.value) in 'sznurówki air force 1 z blaszką') > 0
            order by length(e.value) desc limit 1), 'margin'),
  'Sznur'
where not exists (select 1 from public.catalog_exclusions where kind = 'title_contains' and lower(value) = 'sznurówki air force 1 z blaszką');
update public.catalog_exclusions set receipt_name = 'Sznur'
where kind = 'title_contains' and lower(value) = 'sznurówki air force 1 z blaszką' and receipt_name is null;

notify pgrst, 'reload schema';
