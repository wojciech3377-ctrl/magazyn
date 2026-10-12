-- 0041: Do zrobienia – data rozpoczęcia (domyślnie dziś) i powtarzanie zadań.
alter table public.tasks add column if not exists start_date date;
update public.tasks set start_date = coalesce(start_date, created_at::date);
alter table public.tasks add column if not exists repeat text not null default 'none';
alter table public.tasks drop constraint if exists tasks_repeat_check;
alter table public.tasks add constraint tasks_repeat_check check (repeat in ('none', 'daily', 'weekdays', 'weekly', 'monthly'));

notify pgrst, 'reload schema';
