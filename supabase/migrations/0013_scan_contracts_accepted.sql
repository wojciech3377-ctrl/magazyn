-- Wgrane skany umów nie wymagają zatwierdzania: od razu są „zaakceptowane”.
-- „Do zatwierdzenia” dotyczy tylko umów podpisanych przez klienta przez link.
-- Wklej całość w Supabase → SQL Editor → Run.

alter table public.contracts alter column status set default 'accepted';

update public.contracts
set status = 'accepted', accepted_at = coalesce(accepted_at, created_at)
where template is null and status = 'signed';
