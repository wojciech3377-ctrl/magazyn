-- 0081: Częściowa realizacja zamówienia.
-- • Paragon fiskalny do wybranych pozycji zamówienia (np. 1 z 2 produktów), resztę osobnym paragonem.
--   receipt_jobs.order_lines / receipts.order_lines = lista ID pozycji Shopify (+ "shipping" – koszt wysyłki);
--   null = całe zamówienie (jak dotąd).
-- • Paczka z wybranymi pozycjami: shipments.order_lines = {ID pozycji: sztuk}; w Shopify oznaczane jako wysłane
--   tylko te pozycje.
-- • Sztuka z magazynu przechodzi w „sprzedana” dopiero, gdy jej pozycja ma paragon (albo całe zamówienie ma
--   paragon / fakturę).
-- Można uruchomić kilka razy.

alter table public.receipt_jobs add column if not exists order_lines jsonb;
alter table public.receipts add column if not exists order_lines jsonb;
alter table public.shipments add column if not exists order_lines jsonb;

-- Jeden paragon do CAŁEGO zamówienia (jak dotąd); paragony częściowe – bez nakładania się pozycji (wyzwalacz niżej).
drop index if exists public.receipt_jobs_order_uq;
create unique index if not exists receipt_jobs_order_full_uq on public.receipt_jobs (order_id)
  where order_id is not null and order_lines is null and status in ('queued', 'printing', 'printed');

-- Te same pozycje nie mogą trafić na dwa paragony (także przy dwóch kliknięciach naraz – blokada na zamówienie).
create or replace function public.receipt_jobs_no_overlap() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.order_id is null or new.status not in ('queued', 'printing', 'printed') then return new; end if;
  perform pg_advisory_xact_lock(hashtext('receipt-order:' || new.order_id::text));
  if exists (
    select 1 from public.receipt_jobs j
    where j.order_id = new.order_id and j.id <> new.id and j.status in ('queued', 'printing', 'printed')
      and (j.order_lines is null or new.order_lines is null
           or exists (select 1 from jsonb_array_elements_text(j.order_lines) a(x) where new.order_lines ? a.x))
  ) then
    raise exception 'Te pozycje mają już paragon (albo jest paragon do całego zamówienia).' using errcode = '23505';
  end if;
  return new;
end $$;
revoke all on function public.receipt_jobs_no_overlap() from public, anon, authenticated;
drop trigger if exists receipt_jobs_no_overlap on public.receipt_jobs;
create trigger receipt_jobs_no_overlap before insert or update of status, order_lines on public.receipt_jobs
  for each row execute function public.receipt_jobs_no_overlap();

-- Paragon z drukarki dostaje listę pozycji ze swojego zadania.
create or replace function public.receipts_job_lines() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.job_id is not null and new.order_lines is null then
    select j.order_lines into new.order_lines from public.receipt_jobs j where j.id = new.job_id;
  end if;
  return new;
end $$;
revoke all on function public.receipts_job_lines() from public, anon, authenticated;
drop trigger if exists receipts_job_lines on public.receipts;
create trigger receipts_job_lines before insert on public.receipts
  for each row execute function public.receipts_job_lines();

-- Wynik wydruku: przy paragonie częściowym anulowane są tylko zadania z tymi samymi pozycjami.
create or replace function public.finish_receipt_job(p_printer uuid, p_id uuid, p_ok boolean, p_number text, p_error text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  j public.receipt_jobs%rowtype;
begin
  select * into j from public.receipt_jobs where id = p_id for update;
  if not found then raise exception 'Nie ma takiego zadania'; end if;
  if j.status = 'printed' then return 'printed'; end if;
  if not p_ok then
    -- Błąd liczy się tylko od drukarki, która właśnie drukuje to zadanie.
    if j.status <> 'printing' or j.printer_id is distinct from p_printer then return j.status; end if;
    update public.receipt_jobs set status = 'error', error = left(coalesce(p_error, 'błąd drukarki'), 1000) where id = p_id;
    return 'error';
  end if;
  -- Paragon wyszedł z drukarki: zapisujemy go zawsze (także gdy zadanie zdążyło wrócić do kolejki albo ma błąd).
  -- Inne czekające zadania tej samej sprzedaży są już zbędne (paragon istnieje) – anulujemy je.
  -- Paragony częściowe (SQL 81): tylko te z tymi samymi pozycjami (paragon do innych pozycji zostaje w kolejce).
  update public.receipt_jobs set status = 'cancelled', error = 'zbędne – paragon tej sprzedaży już wydrukowany'
   where id <> p_id and status = 'queued'
     and ((j.pos_order_id is not null and pos_order_id = j.pos_order_id)
          or (j.order_id is not null and order_id = j.order_id
              and (j.order_lines is null or order_lines is null
                   or exists (select 1 from jsonb_array_elements_text(order_lines) a(x) where j.order_lines ? a.x))));
  begin
    update public.receipt_jobs set status = 'printed', printer_id = coalesce(p_printer, printer_id), receipt_number = left(p_number, 60),
      printed_at = now(), error = null where id = p_id;
  exception when unique_violation then
    -- Sprzedaż ma już inny wydrukowany paragon: ten też istnieje (podwójny paragon) – zapisujemy i oznaczamy do sprawdzenia.
    update public.receipt_jobs set status = 'error', printer_id = coalesce(p_printer, printer_id), receipt_number = left(p_number, 60),
      printed_at = now(), error = 'Wydrukowany, ale ta sprzedaż ma już inny paragon – sprawdź (możliwy podwójny paragon).' where id = p_id;
  end;
  if j.source <> 'test' then
    insert into public.receipts (source, number, issued_at, pos_order_id, order_id, job_id, currency, items, created_by)
    values ('printer', left(p_number, 60), now(), j.pos_order_id, j.order_id, j.id, 'PLN',
      (select coalesce(jsonb_agg(jsonb_build_object('name', l->>'name', 'quantity', (l->>'qty')::numeric, 'price_brutto', (l->>'price')::numeric,
        'tax_rate', coalesce(nullif(l->>'rate', '')::numeric, case when l->>'ptu' = 'A' then 23 else 0 end), 'ptu', l->>'ptu')), '[]'::jsonb)
       from jsonb_array_elements(j.lines) l),
      j.created_by);
    if j.order_id is not null then
      update public.orders set receipt_at = now() where id = j.order_id;
      perform public.settle_order_units();
    end if;
  end if;
  return 'printed';
end;
$$;
revoke all on function public.finish_receipt_job(uuid, uuid, boolean, text, text) from public, anon, authenticated;
grant execute on function public.finish_receipt_job(uuid, uuid, boolean, text, text) to service_role;

-- Rozliczenie rezerwacji: paragon częściowy rozlicza tylko sztuki swoich pozycji.
create or replace function public.settle_order_units()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  n int;
begin
  if auth.uid() is not null and not public.is_staff() then
    raise exception 'Brak uprawnień';
  end if;
  with done as (
    select distinct s.unit_id, s.id as sale_id, o.name, o.ordered_at
    from public.sales s
    join public.orders o on o.id = s.order_id
    join public.units u on u.id = s.unit_id
    where s.status = 'assigned' and u.status = 'reserved'
      and (o.receipt_id is not null
           or exists (select 1 from public.receipts r where r.order_id = o.id
                        and (r.order_lines is null or s.shopify_line_id is null or r.order_lines ? s.shopify_line_id))
           or exists (select 1 from public.receipts r where o.base_order_id is not null and r.base_order_id = o.base_order_id)
           or exists (select 1 from public.invoices i where i.order_id = o.id and i.status not in ('rejected', 'cancelled')))
  ), upd as (
    update public.units u set status = 'sold', sold_at = coalesce(u.sold_at, d.ordered_at, now())
    from done d where u.id = d.unit_id and u.status = 'reserved'
    returning u.id, d.sale_id, d.name
  ), ev as (
    insert into public.unit_events (unit_id, type, data)
    select id, 'sold', jsonb_build_object('sale_id', sale_id, 'order', name, 'source', 'paragon / faktura') from upd
    returning 1
  )
  select count(*) into n from ev;
  return n;
end;
$function$;
revoke all on function public.settle_order_units() from public, anon;
grant execute on function public.settle_order_units() to authenticated, service_role;

notify pgrst, 'reload schema';
