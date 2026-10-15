-- 0057: znacznik USED na liście WTB (używane buty) – widoczny na karcie, liście do skopiowania i grafice.
alter table public.wtb_items add column if not exists used boolean not null default false;
notify pgrst, 'reload schema';
