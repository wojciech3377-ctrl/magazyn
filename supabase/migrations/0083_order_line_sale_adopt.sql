-- 0083: „Dołącz umowę” do pozycji zamówienia – błąd „Wszystkie przedmioty tego zamówienia mają już linie sprzedaży”,
-- choć pozycja nie ma swojej linii. Linie, które nie pasują do żadnej obecnej pozycji (zamówienie edytowane
-- w Shopify – nowe ID pozycji; linia z Base bez ID pozycji; linie anulowane), były liczone jako zajęte.
-- Teraz:
-- • linia z Base (bez ID pozycji) o tym samym rozmiarze – przejmowana przez tę pozycję (tak też pokazuje ją JPK),
-- • linia „osierocona” (pozycji o tym ID już nie ma w zamówieniu; z Base innego rozmiaru) bez sztuki albo ze sztuką
--   tego rozmiaru – przejmowana,
-- • anulowane i osierocone linie nie liczą się jako zajęte.
-- Można uruchomić kilka razy.

create or replace function public.ensure_order_line_sale(p_order_id uuid, p_line_id text, p_index int)
returns uuid
language plpgsql
as $$
declare
  o public.orders%rowtype;
  l jsonb;
  v_var uuid;
  v_id uuid;
  v_pieces int;
  v_have int;
begin
  select * into o from public.orders where id = p_order_id;
  if not found then raise exception 'Nie ma takiego zamówienia'; end if;
  perform public.lock_order_keys(o.store_id, array[o.number, o.shopify_legacy_id]);
  if o.cancelled_at is not null then raise exception 'Zamówienie jest anulowane – nie ma sprzedanego przedmiotu'; end if;
  select e into l from jsonb_array_elements(o.line_items) e where e ->> 'id' = p_line_id limit 1;
  if l is null then raise exception 'Nie ma takiej pozycji w zamówieniu'; end if;
  if p_index < 0 or p_index >= greatest(coalesce((l ->> 'quantity')::int, 1), 1) then raise exception 'Zła sztuka pozycji'; end if;
  -- Zwrócone sztuki pozycji (liczone od końca) nie są sprzedane.
  if p_index >= greatest(coalesce((l ->> 'quantity')::int, 1), 1) - coalesce((o.refunded_lines ->> p_line_id)::int, 0) then
    raise exception 'Ta sztuka została zwrócona – nie ma sprzedanego przedmiotu';
  end if;

  select id into v_id from public.sales where order_id = p_order_id and shopify_line_id = p_line_id and shopify_line_index = p_index;
  if found then return v_id; end if;

  if nullif(l ->> 'shopify_variant_id', '') is not null then
    select variant_id into v_var from public.variant_store_links
     where shopify_variant_id = l ->> 'shopify_variant_id'
     order by (store_id = o.store_id) desc limit 1;
  end if;

  -- 1) Linia z Base (bez ID pozycji) tego samego rozmiaru → ta pozycja (JPK i Sprzedaż już ją tak łączą).
  if v_var is not null then
    select s.id into v_id from public.sales s
     where s.order_id = p_order_id and s.shopify_line_id is null and s.variant_id = v_var and s.status <> 'cancelled'
     order by s.line_index nulls last, s.id limit 1 for update;
    if found then
      update public.sales set shopify_line_id = p_line_id, shopify_line_index = p_index where id = v_id;
      return v_id;
    end if;
  end if;

  -- 2) Linia osierocona: pozycji o jej ID (albo tej sztuki) już nie ma w zamówieniu (np. edycja zamówienia w Shopify)
  --    albo linia z Base innego rozmiaru. Przejmujemy ją, jeśli nie ma sztuki albo ma sztukę tego samego rozmiaru.
  select s.id into v_id from public.sales s
    left join public.units u on u.id = s.unit_id
   where s.order_id = p_order_id and s.status <> 'cancelled'
     and (s.shopify_line_id is null or not exists (select 1 from jsonb_array_elements(o.line_items) e
                      where e ->> 'id' = s.shopify_line_id
                        and coalesce(s.shopify_line_index, 0) < greatest(coalesce((e ->> 'quantity')::int, 1), 1)))
     and (s.unit_id is null or (v_var is not null and u.variant_id = v_var))
     -- Linia z Base rozmiaru, który ma inna pozycja tego zamówienia, należy do tamtej pozycji.
     and not (s.shopify_line_id is null and s.variant_id is not null and exists (
       select 1 from jsonb_array_elements(o.line_items) e
         join public.variant_store_links vl on vl.shopify_variant_id = e ->> 'shopify_variant_id'
        where vl.variant_id = s.variant_id))
   order by (s.unit_id is not null) desc, s.id limit 1
   for update of s;
  if found then
    update public.sales set shopify_line_id = p_line_id, shopify_line_index = p_index, line_index = p_index,
      variant_id = case when unit_id is null then v_var else variant_id end,
      status = case when unit_id is not null then status when v_var is null then 'unmatched' else 'no_unit' end,
      product_name = concat_ws(' ', l ->> 'title', l ->> 'variant_title'),
      price = coalesce(nullif(l ->> 'price', '')::numeric, price)
     where id = v_id;
    return v_id;
  end if;

  -- 3) Bez dublowania: liczą się tylko żywe linie przypięte do obecnych pozycji (albo z Base bez ID pozycji).
  select coalesce(sum(greatest(coalesce((e ->> 'quantity')::int, 1), 1)), 0) into v_pieces
    from jsonb_array_elements(o.line_items) e where coalesce((e ->> 'service')::boolean, false) = false;
  select count(*) into v_have from public.sales s
   where s.order_id = p_order_id and s.status <> 'cancelled'
     and (s.shopify_line_id is null or exists (select 1 from jsonb_array_elements(o.line_items) e
                                                where e ->> 'id' = s.shopify_line_id
                                                  and coalesce(s.shopify_line_index, 0) < greatest(coalesce((e ->> 'quantity')::int, 1), 1)));
  if v_have >= v_pieces then
    raise exception 'Wszystkie przedmioty tego zamówienia mają już linie sprzedaży (zamówienie % – sprawdź je w Sprzedaży: linia z innym rozmiarem albo ze sztuką innego produktu)', o.name;
  end if;
  if v_var is not null then
    select coalesce(sum(greatest(coalesce((e ->> 'quantity')::int, 1), 1)), 0) into v_pieces
      from jsonb_array_elements(o.line_items) e
     where e ->> 'shopify_variant_id' = l ->> 'shopify_variant_id' and coalesce((e ->> 'service')::boolean, false) = false;
    select count(*) into v_have from public.sales s
     where s.order_id = p_order_id and s.variant_id = v_var and s.status <> 'cancelled'
       and (s.shopify_line_id is null or exists (select 1 from jsonb_array_elements(o.line_items) e
                                                  where e ->> 'id' = s.shopify_line_id
                                                    and coalesce(s.shopify_line_index, 0) < greatest(coalesce((e ->> 'quantity')::int, 1), 1)));
    if v_have >= v_pieces then raise exception 'Ta pozycja ma już linię sprzedaży – odśwież stronę'; end if;
  end if;

  insert into public.sales (store_id, base_order_id, order_id, shopify_line_id, shopify_line_index, line_index, variant_id,
                            order_ref, product_name, status, sold_at, price)
  values (o.store_id, o.base_order_id, p_order_id, p_line_id, p_index, p_index, v_var,
          o.name, concat_ws(' ', l ->> 'title', l ->> 'variant_title'),
          case when v_var is null then 'unmatched' else 'no_unit' end, o.ordered_at, nullif(l ->> 'price', '')::numeric)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.ensure_order_line_sale(uuid, text, int) from public, anon;
grant execute on function public.ensure_order_line_sale(uuid, text, int) to authenticated;

notify pgrst, 'reload schema';
