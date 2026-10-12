-- Zadania cykliczne (uruchom raz w Supabase → SQL Editor, PO wdrożeniu aplikacji na Vercel).
-- 1. Supabase → Database → Extensions: włącz pg_cron i pg_net.
-- 2. Sekret: jeśli już kiedyś uruchamiałeś ten plik, sekret „cron_secret” jest w Vault – pomiń linię create_secret.
--    Inaczej podmień TWOJ_CRON_SECRET na ten sam ciąg, który jest w Vercel jako CRON_SECRET.

-- select vault.create_secret('TWOJ_CRON_SECRET', 'cron_secret');

-- Stare zadanie (co 5 minut, razem z Base) – wyłączamy.
select cron.unschedule('base-orders') where exists (select 1 from cron.job where jobname = 'base-orders');

-- Zamówienia, zmienione stany, przesyłki, KSeF – co minutę.
select cron.schedule(
  'magazyn-sync',
  '* * * * *',
  $$
  select net.http_get(
    url := 'https://magazyn-two.vercel.app/api/cron/sync',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    timeout_milliseconds := 55000
  );
  $$
);

-- Katalog produktów ze Shopify i pełne porównanie stanów – co 10 minut.
select cron.schedule(
  'magazyn-katalog',
  '*/10 * * * *',
  $$
  select net.http_get(
    url := 'https://magazyn-two.vercel.app/api/cron/katalog',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    timeout_milliseconds := 120000
  );
  $$
);
