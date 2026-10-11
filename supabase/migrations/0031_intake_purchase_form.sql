-- Zgłoszenia komisantów: forma rozliczenia każdej rzeczy (VAT marża albo VAT 23%) wybierana przez komisanta.
alter table public.consignor_intake_items add column if not exists purchase_form text not null default 'vat_margin';
alter table public.consignor_intake_items drop constraint if exists consignor_intake_items_purchase_form_check;
alter table public.consignor_intake_items add constraint consignor_intake_items_purchase_form_check check (purchase_form in ('vat_margin', 'vat_23'));

notify pgrst, 'reload schema';
