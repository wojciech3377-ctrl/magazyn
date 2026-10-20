-- 0075: W drodze – zwykłe notatki z polem „Doszło” (np. „paczka od Kowalskiego, 2 pary”), bez sztuk w magazynie.
-- Można uruchomić kilka razy.
create table if not exists public.transit_notes (
  id uuid primary key default gen_random_uuid(),
  text text not null check (length(trim(text)) > 0),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  arrived_at timestamptz,
  arrived_by uuid
);
create index if not exists transit_notes_open_idx on public.transit_notes (created_at desc) where arrived_at is null;
alter table public.transit_notes enable row level security;
drop policy if exists transit_notes_staff on public.transit_notes;
create policy transit_notes_staff on public.transit_notes for all to authenticated using (public.is_staff()) with check (public.is_staff());
notify pgrst, 'reload schema';
