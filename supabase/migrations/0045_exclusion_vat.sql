-- 0045: stawka na paragonie dla pozycji wykluczonych z magazynu (np. sznurówki rope).
-- 'margin' = VAT marża (na drukarce stawka „marża” z Ustawień → Drukarka fiskalna, domyślnie F), '23' = 23% (A).
-- Nowe reguły: domyślnie marża. Istniejące reguły zachowują dotychczasowy druk 23% (usługi, naprawy),
-- poza regułami z „rope” / „sznur” w nazwie – te od razu marża. Zmienisz to przy każdej regule w Ustawieniach → Wykluczenia.
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'catalog_exclusions' and column_name = 'vat') then
    alter table public.catalog_exclusions add column vat text not null default 'margin';
    update public.catalog_exclusions set vat = case when value ~* '(rope|sznur)' then 'margin' else '23' end;
  end if;
end $$;
alter table public.catalog_exclusions drop constraint if exists catalog_exclusions_vat_check;
alter table public.catalog_exclusions add constraint catalog_exclusions_vat_check check (vat in ('margin', '23'));
notify pgrst, 'reload schema';
