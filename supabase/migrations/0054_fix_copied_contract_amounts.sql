-- 0054: naprawa powielonej kwoty umowy. Wcześniej przy dołączaniu umowy (np. faktury na kilka rzeczy) do sprzedanych
-- pozycji każda sztuka dostawała całą kwotę umowy. Jeśli na jednej umowie co najmniej 2 sztuki mają cenę zakupu równą
-- całej kwocie umowy (bez cen pozycji w umowie) – cena tych sztuk jest czyszczona, żeby wpisać ją osobno dla każdej rzeczy.
-- Najpierw podgląd (uruchom sam SELECT, jeśli chcesz zobaczyć, czego dotyczy):
--   select c.doc_number, c.counterparty, c.amount, c.currency, u.code, u.purchase_price
--   from public.units u join public.contracts c on c.id = u.contract_id
--   where u.purchase_price = c.amount and coalesce(jsonb_array_length(c.items), 0) = 0
--     and (select count(*) from public.units x where x.contract_id = c.id and x.purchase_price = c.amount) >= 2;
with copied as (
  select u.id
  from public.units u
  join public.contracts c on c.id = u.contract_id
  where c.amount is not null
    and u.purchase_price = c.amount
    and not exists (select 1 from jsonb_array_elements(coalesce(c.items, '[]'::jsonb)) i where coalesce((i->>'price')::numeric, 0) > 0)
    and (select count(*) from public.units x where x.contract_id = c.id and x.purchase_price = c.amount) >= 2
)
update public.units u set purchase_price = null from copied where u.id = copied.id;
