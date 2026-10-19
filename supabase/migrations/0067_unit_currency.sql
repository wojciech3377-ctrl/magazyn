-- 0067: waluta ceny zakupu / kwoty komisanta sztuki (Przyjęcie dostawy bez umowy w EUR). Przy umowie liczy się waluta umowy.
alter table public.units add column if not exists purchase_currency text;
alter table public.units drop constraint if exists units_purchase_currency_check;
alter table public.units add constraint units_purchase_currency_check check (purchase_currency is null or purchase_currency in ('PLN', 'EUR'));
notify pgrst, 'reload schema';
