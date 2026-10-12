-- Test kolejki paragonów fiskalnych: pobranie przez program, wynik, paragon w tabeli paragonów.
\set ON_ERROR_STOP on
begin;
insert into public.fiscal_printers (id, name, token_hash) values ('40000000-0000-0000-0000-000000000001', 'Kasa', 'x');
insert into public.orders (id, store_id, shopify_order_id, name, number, ordered_at)
select '30000000-0000-0000-0000-000000000009', id, 'gid://shopify/Order/9', '#9', '9', now() from public.stores where code = 'sneakers-depot';
insert into public.receipt_jobs (id, source, order_id, lines, total, payment)
values ('50000000-0000-0000-0000-000000000001', 'order', '30000000-0000-0000-0000-000000000009', '[{"name":"Buty","qty":1,"price":100,"ptu":"F"},{"name":"Wysyłka","qty":1,"price":15,"ptu":"A"}]', 115, 'transfer');
do $$
declare j public.receipt_jobs%rowtype;
begin
  -- drugi paragon do tego samego zamówienia nie przejdzie
  begin
    insert into public.receipt_jobs (source, order_id, lines) values ('order', '30000000-0000-0000-0000-000000000009', '[]');
    raise exception 'duplikat nie powinien przejść';
  exception when unique_violation then null;
  end;
  select * into j from public.claim_receipt_job('40000000-0000-0000-0000-000000000001');
  if j.id is null or j.status <> 'printing' then raise exception 'program nie dostał paragonu'; end if;
  if exists (select 1 from public.claim_receipt_job('40000000-0000-0000-0000-000000000001')) then raise exception 'ten sam paragon drugi raz'; end if;
  perform public.finish_receipt_job('40000000-0000-0000-0000-000000000001', j.id, true, '000123', null);
  if (select number from public.receipts where order_id = '30000000-0000-0000-0000-000000000009') <> '000123' then raise exception 'brak paragonu w tabeli'; end if;
  if (select (items->1->>'tax_rate')::int from public.receipts where order_id = '30000000-0000-0000-0000-000000000009') <> 23 then raise exception 'zła stawka'; end if;
  if public.finish_receipt_job('40000000-0000-0000-0000-000000000001', j.id, true, '000123', null) <> 'printed' then raise exception 'ponowne potwierdzenie'; end if;
  if (select count(*) from public.receipts) <> 1 then raise exception 'paragon zapisany dwa razy'; end if;
end $$;
-- pracownik nie woła funkcji programu
insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000001', 'szef@example.com');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
do $$ begin
  perform public.claim_receipt_job('40000000-0000-0000-0000-000000000001');
  raise exception 'pracownik nie powinien pobierać zadań';
exception when insufficient_privilege then null;
end $$;
select status, receipt_number from public.receipt_jobs;
rollback;
