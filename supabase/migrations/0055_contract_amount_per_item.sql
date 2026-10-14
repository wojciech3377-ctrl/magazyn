-- 0055: kwota umowy „za każdą rzecz” (np. faktura na 17 Bearbricków po 4166 EUR) – każda przypięta rzecz dostaje tę kwotę.
alter table public.contracts add column if not exists amount_per_item boolean not null default false;
notify pgrst, 'reload schema';
