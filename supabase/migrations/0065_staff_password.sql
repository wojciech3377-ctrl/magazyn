-- 0065: pracownik z hasłem startowym (nowe konto albo hasło nadane przez administratora) przy logowaniu ustawia własne hasło.
alter table public.profiles add column if not exists must_change_password boolean not null default false;
notify pgrst, 'reload schema';
