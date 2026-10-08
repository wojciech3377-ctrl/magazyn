-- Umowa: forma zapłaty (przelew / gotówka), waluta i kraj sprzedającego.
-- Wklej całość w Supabase → SQL Editor → Run.

alter table public.contracts
  add column if not exists payment_method text check (payment_method in ('transfer', 'cash')),
  add column if not exists currency text,
  add column if not exists seller_country text,
  add column if not exists language text;
