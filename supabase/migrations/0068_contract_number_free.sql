-- 0068: numer nowej umowy (także przy podziale umowy na kilka rzeczy) – zawsze wolny.
-- Przed zapisem sprawdzamy, czy taki numer już jest w bazie: jako numer innej umowy albo jako numer
-- wpisany / odczytany ze skanu (np. „NR00512”, „512”). Zajęty → kolejny o jeden wyższy, aż do wolnego.
-- Można uruchomić kilka razy.

-- Numer ze skanu w postaci liczby: „NR00512”, „nr 512”, „512” → 512; inne (np. „FT 77/2026”) → null.
create or replace function public.contract_doc_number_int(p text) returns bigint
language sql immutable set search_path = public as $$
  select case
    when p ~* '^\s*nr\s*\.?\s*0*\d{1,15}\s*$' then nullif(regexp_replace(p, '\D', '', 'g'), '')::bigint
    when p ~ '^\s*\d{1,15}\s*$' then trim(p)::bigint
  end
$$;

create index if not exists contracts_doc_number_int_idx on public.contracts (public.contract_doc_number_int(doc_number))
  where doc_number is not null;

create or replace function public.contracts_free_number() returns trigger
language plpgsql security definer set search_path = public as $$
declare guard int := 0;
begin
  if new.number is null then return new; end if;
  -- Jedna nowa umowa naraz (dwie równoczesne nie wezmą tego samego numeru).
  perform pg_advisory_xact_lock(hashtext('contracts_free_number'));
  while exists (select 1 from public.contracts c where c.number = new.number and c.id is distinct from new.id)
     or exists (select 1 from public.contracts c where public.contract_doc_number_int(c.doc_number) = new.number and c.id is distinct from new.id) loop
    guard := guard + 1;
    if guard > 100000 then raise exception 'Nie znaleziono wolnego numeru umowy'; end if;
    -- O jeden wyżej; licznik nie cofa się, więc następne umowy też dostaną wolne numery.
    new.number := new.number + 1;
    if new.number > (select last_value from public.contract_number_seq) then
      perform setval('public.contract_number_seq', new.number);
    end if;
  end loop;
  return new;
end $$;
revoke all on function public.contracts_free_number() from public, anon, authenticated;

drop trigger if exists contracts_free_number on public.contracts;
create trigger contracts_free_number before insert on public.contracts
  for each row execute function public.contracts_free_number();
