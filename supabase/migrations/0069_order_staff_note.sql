-- 0069: notatka pracowników do zamówienia – widoczna na czerwono na górze zamówienia i na liście.
-- (Kolumna `note` to uwagi klienta ze Shopify – nadpisywane przy odczycie, dlatego osobne pole.)
-- Można uruchomić kilka razy.
alter table public.orders add column if not exists staff_note text;
alter table public.orders add column if not exists staff_note_by text;
alter table public.orders add column if not exists staff_note_at timestamptz;
notify pgrst, 'reload schema';
