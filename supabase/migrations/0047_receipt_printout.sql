-- 0047: paragon z drukarki – numer w dobie fiskalnej i treść paragonu (z kopii elektronicznej) obok numeru wydruku.
-- Numer paragonu w aplikacji = numer wydruku z papieru (np. 000001441); numer w dobie (1, 2, 3… od raportu dobowego) osobno.
alter table public.receipt_jobs add column if not exists daily_no text;
alter table public.receipt_jobs add column if not exists printout_text text;
alter table public.receipts add column if not exists daily_no text;
notify pgrst, 'reload schema';
