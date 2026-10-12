-- Kasa: pozycje bez sztuki z magazynu (własny produkt ze stanem, usługa bez stanu, wpisana ręcznie).
\set ON_ERROR_STOP on
begin;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000001', 'szef@example.com');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
insert into public.pos_products (id, name, price, ptu, track_stock, stock) values
  ('60000000-0000-0000-0000-000000000001', 'Renowacja obuwia', 120, 'A', false, 0),
  ('60000000-0000-0000-0000-000000000002', 'Pasta do butów', 25, 'A', true, 2);
do $$
declare v uuid;
begin
  v := public.create_pos_order((select id from public.stores where code = 'sneakers-depot'),
    '[{"name":"Renowacja obuwia","ptu":"A","price":120,"product_id":"60000000-0000-0000-0000-000000000001"},
      {"name":"Pasta do butów","ptu":"A","price":25,"quantity":2,"product_id":"60000000-0000-0000-0000-000000000002"},
      {"name":"Buty na zamówienie","ptu":"F","price":900}]'::jsonb, 'cash');
  if (select total from public.pos_orders where id = v) <> 1070 then raise exception 'zła suma: %', (select total from public.pos_orders where id = v); end if;
  if (select stock from public.pos_products where id = '60000000-0000-0000-0000-000000000002') <> 0 then raise exception 'stan pasty'; end if;
  begin
    perform public.create_pos_order((select id from public.stores where code = 'sneakers-depot'), '[{"name":"Pasta do butów","ptu":"A","price":25,"product_id":"60000000-0000-0000-0000-000000000002"}]'::jsonb);
    raise exception 'brak stanu powinien zablokować';
  exception when raise_exception then if sqlerrm not like 'Produktu%' then raise; end if;
  end;
  begin
    perform public.create_pos_order((select id from public.stores where code = 'sneakers-depot'), '[{"name":"X","price":5}]'::jsonb);
    raise exception 'brak PTU powinien zablokować';
  exception when raise_exception then if sqlerrm not like 'Wybierz stawkę%' then raise; end if;
  end;
end $$;
select name, ptu, quantity, price from public.pos_order_items order by price desc;
rollback;
