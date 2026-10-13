-- 0046: paragony fiskalne zostają na zawsze (JPK), nawet gdy ich sprzedaż zostanie usunięta,
-- i mają numer dokładnie taki jak na wydruku z drukarki (9 cyfr z zerami, np. 000001441).

-- 1. Usunięcie sprzedaży z Kasy nie usuwa już paragonu – tylko odpina go od sprzedaży.
alter table public.receipts drop constraint if exists receipts_pos_order_id_fkey;
alter table public.receipts add constraint receipts_pos_order_id_fkey
  foreign key (pos_order_id) references public.pos_orders (id) on delete set null;

-- 2. Opis sprzedaży zapisany przy paragonie (kod sprzedaży z Kasy / numer zamówienia) – widoczny w JPK także po usunięciu sprzedaży.
alter table public.receipts add column if not exists sale_ref text;
update public.receipts r set sale_ref = coalesce(
  (select p.code from public.pos_orders p where p.id = r.pos_order_id),
  (select o.name from public.orders o where o.id = r.order_id))
where r.sale_ref is null;

create or replace function public.receipt_sale_ref()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.sale_ref is null then
    new.sale_ref := coalesce(
      (select p.code from public.pos_orders p where p.id = new.pos_order_id),
      (select o.name from public.orders o where o.id = new.order_id));
  end if;
  return new;
end;
$$;
revoke all on function public.receipt_sale_ref() from public, anon, authenticated;
drop trigger if exists receipts_sale_ref on public.receipts;
create trigger receipts_sale_ref before insert on public.receipts for each row execute function public.receipt_sale_ref();

-- 3. Numer paragonu z drukarki fiskalnej w pełnym formacie z wydruku (9 cyfr), np. 1441 → 000001441.
update public.receipts set number = lpad(number, 9, '0') where source = 'printer' and number ~ '^\d{1,8}$';
update public.receipt_jobs set receipt_number = lpad(receipt_number, 9, '0') where receipt_number ~ '^\d{1,8}$';

notify pgrst, 'reload schema';
