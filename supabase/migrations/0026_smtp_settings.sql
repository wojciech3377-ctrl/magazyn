-- Wysyłka e-maili ustawiana w aplikacji (Ustawienia → Faktury): serwer, login i nadawca w app_settings,
-- hasło wyłącznie w Supabase Vault (zaszyfrowane). Funkcje tylko dla serwera (service_role).

create or replace function public.smtp_password_set(p_password text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if coalesce(p_password, '') = '' then
    delete from vault.secrets where name = 'smtp_password';
    return;
  end if;
  select id into v_id from vault.secrets where name = 'smtp_password';
  if v_id is null then
    perform vault.create_secret(p_password, 'smtp_password', 'Hasło SMTP (Ustawienia aplikacji)');
  else
    perform vault.update_secret(v_id, p_password);
  end if;
end;
$$;
revoke all on function public.smtp_password_set(text) from public, anon, authenticated;

create or replace function public.smtp_password_get()
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return (select decrypted_secret from vault.decrypted_secrets where name = 'smtp_password' limit 1);
end;
$$;
revoke all on function public.smtp_password_get() from public, anon, authenticated;

-- Czy hasło jest zapisane (bez ujawniania go) – do ekranu ustawień.
create or replace function public.smtp_password_exists()
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return exists (select 1 from vault.secrets where name = 'smtp_password');
end;
$$;
revoke all on function public.smtp_password_exists() from public, anon, authenticated;

notify pgrst, 'reload schema';
