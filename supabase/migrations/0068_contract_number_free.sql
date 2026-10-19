-- 0068: numer nowej umowy (także przy podziale umowy na kilka rzeczy) – zawsze wolny.
-- Umowa nazywa się jak w PDF: NR + numer (np. NR63). Przed zapisem sprawdzamy, czy taka nazwa już jest w bazie:
-- numer innej umowy albo dokładnie taki sam numer wpisany przy skanie („NR63”, „nr 63”). Zajęty → o jeden wyższy.
-- Stare umowy z innym zapisem (np. „NR00063” z zerami) to inne numery – nie blokują i niczego w nich nie zmieniamy.
-- Można uruchomić kilka razy (także po wcześniejszej wersji tego pliku).

drop index if exists public.contracts_doc_number_int_idx;
drop function if exists public.contract_doc_number_int(text);

-- Nazwa ze skanu bez spacji i wielkości liter: „nr 63” → „NR63”.
create or replace function public.contract_doc_name(p text) returns text
language sql immutable set search_path = public as $$
  select nullif(upper(regexp_replace(coalesce(p, ''), '\s', '', 'g')), '')
$$;

create index if not exists contracts_doc_name_idx on public.contracts (public.contract_doc_name(doc_number))
  where doc_number is not null;

create or replace function public.contracts_free_number() returns trigger
language plpgsql security definer set search_path = public as $$
declare guard int := 0;
begin
  if new.number is null then return new; end if;
  -- Jedna nowa umowa naraz (dwie równoczesne nie wezmą tego samego numeru).
  perform pg_advisory_xact_lock(hashtext('contracts_free_number'));
  while exists (select 1 from public.contracts c where c.number = new.number and c.id is distinct from new.id)
     or exists (select 1 from public.contracts c where public.contract_doc_name(c.doc_number) = 'NR' || new.number and c.id is distinct from new.id) loop
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
