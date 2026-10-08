-- Zakładki w Umowach: oczekujące, w drodze, do opłaty, gotowe, odrzucone.
-- Wklej całość w Supabase → SQL Editor → Run.

alter table public.contracts
  add column if not exists paid_at timestamptz,
  add column if not exists paid_by uuid references auth.users (id);

create or replace view public.contract_overview with (security_invoker = true) as
select
  c.id, c.number, c.type, c.counterparty, c.contract_date, c.amount, c.currency, c.file_path, c.created_at,
  c.status, c.source, c.template, c.units_created_at, c.paid_at, c.payment_method,
  count(u.id) as units_total,
  count(u.id) filter (where u.status = 'in_transit') as units_in_transit,
  case
    when c.status in ('rejected', 'cancelled') then 'rejected'
    when c.status = 'sent' or (c.status = 'signed' and c.template is not null) then 'pending'
    when c.paid_at is not null or c.template is null then 'done'          -- opłacone; wgrane skany traktujemy jako zamknięte
    when count(u.id) filter (where u.status = 'in_transit') > 0 then 'in_transit'
    else 'to_pay'
  end as category
from public.contracts c
left join public.units u on u.contract_id = c.id
group by c.id;
