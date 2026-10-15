-- 0061: błędy automatu (odczyt katalogu, stany, zamówienia…) – czerwony licznik przy Ustawieniach i lista z opisem,
-- co się dzieje i co zrobić. Błąd znika sam, gdy kolejny przebieg automatu już go nie widzi.
create table if not exists public.app_issues (
  key text primary key,
  source text not null,
  title text not null,
  detail text,
  hint text,
  href text,
  show_after int not null default 1,
  count int not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  dismissed_at timestamptz
);
create index if not exists app_issues_open_idx on public.app_issues (source) where resolved_at is null;

alter table public.app_issues enable row level security;
drop policy if exists app_issues_admin_read on public.app_issues;
create policy app_issues_admin_read on public.app_issues for select to authenticated using (public.is_admin());
revoke insert, update, delete on public.app_issues from anon, authenticated;
revoke all on public.app_issues from anon;

notify pgrst, 'reload schema';
