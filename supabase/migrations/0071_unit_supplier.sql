-- 0071: „Od kogo” przy rzeczach (sprzedający / dostawca) – wpisywane przy przyjęciu dostawy, rzeczach w drodze
-- i umowie z szablonu; widoczne w W drodze, Do zrobienia i na karcie sztuki. Można uruchomić kilka razy.
alter table public.units add column if not exists supplier text;
notify pgrst, 'reload schema';
