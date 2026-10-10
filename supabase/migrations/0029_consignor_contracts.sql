-- Komis: e-mail do komisanta po sprzedaży jego rzeczy (z linkiem do panelu: umowa do podpisu albo faktura).
-- Rzeczy sprzedane przed tą zmianą uznajemy za zgłoszone – e-maile idą tylko o nowej sprzedaży.

alter table public.units add column if not exists consignor_notified_at timestamptz;

update public.units
set consignor_notified_at = coalesce(sold_at, now())
where owner_type = 'consignment' and status in ('sold', 'shipped') and consignor_notified_at is null;

create index if not exists units_consignor_notify_idx on public.units (sold_at)
  where owner_type = 'consignment' and consignor_notified_at is null;

-- Umowy od komisanta (z panelu): po komisancie, do podglądu jego umów.
create index if not exists contracts_consignor_idx on public.contracts (consignor_id) where consignor_id is not null;

notify pgrst, 'reload schema';
