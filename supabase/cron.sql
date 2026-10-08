-- Odczyt zamówień z Base co 5 minut (uruchom raz, PO wdrożeniu aplikacji na Vercel).
-- 1. Supabase → Database → Extensions: włącz pg_cron i pg_net.
-- 2. Podmień TWOJ_CRON_SECRET na ten sam ciąg, który wpisałeś w Vercel jako CRON_SECRET,
--    potem Run. Sekret trafia do Vault, nie do treści zadania.

select vault.create_secret('TWOJ_CRON_SECRET', 'cron_secret');

select cron.schedule(
  'base-orders',
  '*/5 * * * *',
  $$
  select net.http_get(
    url := 'https://magazyn-two.vercel.app/api/cron/base-orders',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    timeout_milliseconds := 120000
  );
  $$
);
