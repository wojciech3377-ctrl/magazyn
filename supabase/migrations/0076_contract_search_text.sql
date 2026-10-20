-- 0076: Umowy – wyszukiwanie po wszystkim, co jest w umowie.
-- Tekst do wyszukiwania: wszystkie pola umowy (numer, numer z dokumentu, sprzedający, adres, e-mail, telefon, konto,
-- NIP, notatki, pozycje, nazwa pliku, kwota, waluta…), data jak w aplikacji (DD.MM.RRRR), „NR63”, komisant oraz
-- przypięte sztuki (kod, IMEI / numer seryjny, „od kogo”, produkt, rozmiar, SKU).
-- Kolumna wyliczana `search_text` w widokach contract_overview i contract_overview_unused (filtr w API).
-- Można uruchomić kilka razy.

create or replace function public.contract_search_text(p_id uuid) returns text
language sql stable security invoker set search_path = public as $$
  select lower(concat_ws(' ',
    -- bez identyfikatorów, linków do podpisu i obrazków podpisu
    (select string_agg(j.value, ' ') from jsonb_each_text(to_jsonb(c)) j where j.key !~ '(^id$|_id$|token|signature|_path$|_at$)'),
    case when c.number is not null then 'NR' || c.number end,
    to_char(coalesce(c.contract_date, (c.created_at at time zone 'Europe/Warsaw')::date), 'DD.MM.YYYY'),
    (select k.name from public.consignors k where k.id = c.consignor_id),
    (select string_agg(concat_ws(' ', u.code, to_jsonb(u) ->> 'identifier', to_jsonb(u) ->> 'supplier', to_jsonb(u) ->> 'note',
                                 p.title, v.option, p.style_sku), ' ')
       from public.units u
       join public.variants v on v.id = u.variant_id
       join public.products p on p.id = v.product_id
      where u.contract_id = c.id)
  ))
  from public.contracts c where c.id = p_id
$$;
grant execute on function public.contract_search_text(uuid) to authenticated;

create or replace function public.search_text(public.contract_overview) returns text
language sql stable security invoker set search_path = public as $$ select public.contract_search_text($1.id) $$;
grant execute on function public.search_text(public.contract_overview) to authenticated;

create or replace function public.search_text(public.contract_overview_unused) returns text
language sql stable security invoker set search_path = public as $$ select public.contract_search_text($1.id) $$;
grant execute on function public.search_text(public.contract_overview_unused) to authenticated;

revoke all on function public.contract_search_text(uuid) from anon;
revoke all on function public.search_text(public.contract_overview) from anon;
revoke all on function public.search_text(public.contract_overview_unused) from anon;

notify pgrst, 'reload schema';
