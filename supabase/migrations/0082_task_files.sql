-- 0082: Do zrobienia – pliki przy zadaniach (zdjęcia, PDF, dokumenty).
-- tasks.files = [{ path, name, size, type }]; pliki w prywatnym miejscu „task-files” (dostęp tylko przez serwer aplikacji).
-- Można uruchomić kilka razy.

alter table public.tasks add column if not exists files jsonb not null default '[]'::jsonb;

insert into storage.buckets (id, name, public, file_size_limit)
values ('task-files', 'task-files', false, 26214400)
on conflict (id) do nothing;

notify pgrst, 'reload schema';
