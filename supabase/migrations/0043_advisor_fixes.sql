-- 0043: poprawki z Supabase Security Advisor.

-- 1. „Function Search Path Mutable”: stała ścieżka wyszukiwania dla wszystkich funkcji w public
--    (poza funkcjami rozszerzeń, np. pg_trgm). „extensions” zostaje, żeby nic nie przestało działać.
do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    left join pg_depend d on d.objid = p.oid and d.deptype = 'e'
    where n.nspname = 'public' and d.objid is null and p.prokind = 'f'
      and (p.proconfig is null or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))
  loop
    execute format('alter function %s set search_path = public, extensions', f);
  end loop;
end $$;

-- 2. is_staff / is_admin: potrzebne zalogowanym (polityki RLS), niezalogowanym nie.
revoke execute on function public.is_staff() from public, anon;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_staff() to authenticated, service_role;
grant execute on function public.is_admin() to authenticated, service_role;

-- 3. Funkcje z uprawnieniami właściciela wywołuje już tylko serwer aplikacji (po sprawdzeniu uprawnień).
revoke execute on function public.settle_order_units() from public, anon, authenticated;
grant execute on function public.settle_order_units() to service_role;
revoke execute on function public.split_contract(uuid) from public, anon, authenticated;
grant execute on function public.split_contract(uuid) to service_role;
do $$
declare
  f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p where p.proname = 'purge_non_shopify' and p.pronamespace = 'public'::regnamespace loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
