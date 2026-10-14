-- 0051: własne zdjęcia na liście WTB (np. zrobione telefonem). Prywatny kosz – pliki czyta i zapisuje tylko serwer aplikacji.
-- W wtb_items.image_url zdjęcie z kosza zapisane jest jako „wtb:<ścieżka>”, zdjęcia z Shopify zostają adresem https.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('wtb-photos', 'wtb-photos', false, 5242880, array['image/jpeg'])
on conflict (id) do nothing;
