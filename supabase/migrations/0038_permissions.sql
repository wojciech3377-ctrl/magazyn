-- 0038: uprawnienia pracowników – działy aplikacji, do których pracownik ma dostęp (Pracownicy → uprawnienia).
-- Administrator ma dostęp do wszystkiego niezależnie od listy. Dotychczasowi pracownicy dostają wszystkie działy
-- (nic się dla nich nie zmienia), nowi – podstawowe: magazyn, dostawa, kasa, sprzedaż.

alter table public.profiles add column if not exists permissions text[];
update public.profiles
set permissions = array['magazyn', 'dostawa', 'kasa', 'sprzedaz', 'faktury', 'umowy', 'komisanci', 'wtb', 'katalog']
where permissions is null;
alter table public.profiles alter column permissions set default array['magazyn', 'dostawa', 'kasa', 'sprzedaz'];
alter table public.profiles alter column permissions set not null;
alter table public.profiles drop constraint if exists profiles_permissions_known;
alter table public.profiles add constraint profiles_permissions_known check (
  permissions <@ array['magazyn', 'dostawa', 'kasa', 'sprzedaz', 'faktury', 'umowy', 'komisanci', 'wtb', 'katalog']
);
alter table public.profiles add column if not exists phone text;

notify pgrst, 'reload schema';
