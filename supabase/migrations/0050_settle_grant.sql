-- 0050: poprawka do 0043 – przyjęcie towaru „w drodze” (funkcja receive_in_transit) rozlicza zarezerwowane sztuki
-- funkcją settle_order_units w imieniu zalogowanego pracownika. Funkcja ma własne sprawdzenie (tylko pracownik),
-- więc pracownik znów może ją wywołać (komisant i niezalogowani – nie).
grant execute on function public.settle_order_units() to authenticated;
notify pgrst, 'reload schema';
