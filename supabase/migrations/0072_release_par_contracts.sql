-- 0072: sprzedaż z Kasy z samym paragonem PDF (PAR, bez paragonu fiskalnego i bez faktury) jest poza JPK i nie zużywa
-- umowy. Umowy sztuk z takich sprzedaży (zrobionych przed tą zmianą) wracają do niewykorzystanych; w historii sztuki
-- zostaje wpis, z której umowy ją odpięto. Można uruchomić kilka razy (drugi raz nic nie zmienia).

with par_only as (
  select distinct i.pos_order_id
  from public.invoices i
  where i.pos_order_id is not null and i.kind = 'receipt' and i.status not in ('rejected', 'cancelled')
    and not exists (select 1 from public.receipts r where r.pos_order_id = i.pos_order_id)
    and not exists (select 1 from public.invoices f where f.pos_order_id = i.pos_order_id and f.kind <> 'receipt' and f.status not in ('rejected', 'cancelled'))
), picked as (
  select u.id, u.contract_id, (select number from public.invoices i where i.pos_order_id = p.order_id and i.kind = 'receipt' limit 1) as par
  from public.pos_order_items p
  join par_only o on o.pos_order_id = p.order_id
  join public.units u on u.id = p.unit_id
  where p.status <> 'returned' and u.contract_id is not null
), ev as (
  insert into public.unit_events (unit_id, type, data)
  select id, 'contract', jsonb_build_object('detached', contract_id, 'note', 'paragon PDF ' || coalesce(par, '') || ' (poza JPK) – umowa wraca do niewykorzystanych')
  from picked
  returning unit_id
)
update public.units u set contract_id = null
where u.id in (select unit_id from ev);
