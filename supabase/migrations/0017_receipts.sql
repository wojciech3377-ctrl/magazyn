-- Paragon do zamówienia: wystawiany przez Base (addReceipt), drukuje drukarka fiskalna podpięta do Base.
alter table public.orders add column if not exists receipt_id bigint;
alter table public.orders add column if not exists receipt_at timestamptz;
alter table public.orders add column if not exists receipt_by uuid references public.profiles (id);
