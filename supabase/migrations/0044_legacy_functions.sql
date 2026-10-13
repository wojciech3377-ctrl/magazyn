-- 0044: stare funkcje jednorazowego importu stanów z Base – aplikacja ich nie wywołuje, więc nikt z zewnątrz też nie powinien.
do $$
declare
  f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.proname in ('import_initial_stock', 'preview_initial_stock') loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
