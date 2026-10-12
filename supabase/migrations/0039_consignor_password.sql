-- 0039: komisant przy pierwszym logowaniu ustawia własne hasło (hasło startowe od nas przestaje działać).
alter table public.consignors add column if not exists must_change_password boolean not null default false;

-- Konta komisantów, które jeszcze nigdy się nie logowały, też muszą ustawić hasło.
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'auth' and table_name = 'users' and column_name = 'last_sign_in_at') then
    execute 'update public.consignors c set must_change_password = true from auth.users u where u.id = c.user_id and u.last_sign_in_at is null';
  end if;
end $$;

notify pgrst, 'reload schema';
