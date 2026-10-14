-- 0052: numery paragonów z drukarki poprawione na numer z wydruku („nr dok.000001453”),
-- odczytany z treści paragonu zapisanej przez program drukarki (receipt_jobs.printout_text, migracja 0047).
with fixed as (
  select id, lpad(substring(printout_text from '[Nn][Rr][[:space:]]*[Dd][Oo][Kk][[:alnum:]]*\.?[[:space:]]*:?[[:space:]]*([0-9]{1,9})'), 9, '0') as nr
  from public.receipt_jobs
  where status = 'printed' and printout_text ~* 'nr[[:space:]]*dok'
)
update public.receipt_jobs j set receipt_number = f.nr
from fixed f where j.id = f.id and f.nr is not null and f.nr <> '000000000' and j.receipt_number is distinct from f.nr;

update public.receipts r set number = j.receipt_number
from public.receipt_jobs j
where r.job_id = j.id and r.source = 'printer' and j.printout_text ~* 'nr[[:space:]]*dok' and r.number is distinct from j.receipt_number;
