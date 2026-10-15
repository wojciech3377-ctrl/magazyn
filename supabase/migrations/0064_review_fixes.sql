-- 0064: poprawki po przeglądzie aplikacji (można uruchomić wielokrotnie).
--  1. Paragon wydrukowany nie ginie: zgłoszenie wydruku przyjmowane także po ponownym przydzieleniu zadania / błędzie.
--  2. Automat stanów: jeden przebieg naraz; brakujące sztuki liczone względem „na stanie” (bez zarezerwowanych).
--  3. Produkty „nieprzypisane do Shopify” nie są kasowane przy czyszczeniu katalogu.
--  4. Rzecz komisanta sprzedana ponownie (po zwrocie) – komisant znów dostaje e-mail.
--  5. Szybsza Historia magazynu i łączenie sprzedaży z zamówieniami (bez przepisywania wszystkich zamówień co minutę).

-- 1. Zgłoszenie wyniku wydruku.
create or replace function public.finish_receipt_job(p_printer uuid, p_id uuid, p_ok boolean, p_number text, p_error text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  j public.receipt_jobs%rowtype;
begin
  select * into j from public.receipt_jobs where id = p_id for update;
  if not found then raise exception 'Nie ma takiego zadania'; end if;
  if j.status = 'printed' then return 'printed'; end if;
  if not p_ok then
    -- Błąd liczy się tylko od drukarki, która właśnie drukuje to zadanie.
    if j.status <> 'printing' or j.printer_id is distinct from p_printer then return j.status; end if;
    update public.receipt_jobs set status = 'error', error = left(coalesce(p_error, 'błąd drukarki'), 1000) where id = p_id;
    return 'error';
  end if;
  -- Paragon wyszedł z drukarki: zapisujemy go zawsze (także gdy zadanie zdążyło wrócić do kolejki albo ma błąd).
  -- Inne czekające zadania tej samej sprzedaży są już zbędne (paragon istnieje) – anulujemy je.
  update public.receipt_jobs set status = 'cancelled', error = 'zbędne – paragon tej sprzedaży już wydrukowany'
   where id <> p_id and status = 'queued'
     and ((j.pos_order_id is not null and pos_order_id = j.pos_order_id) or (j.order_id is not null and order_id = j.order_id));
  begin
    update public.receipt_jobs set status = 'printed', printer_id = coalesce(p_printer, printer_id), receipt_number = left(p_number, 60),
      printed_at = now(), error = null where id = p_id;
  exception when unique_violation then
    -- Sprzedaż ma już inny wydrukowany paragon: ten też istnieje (podwójny paragon) – zapisujemy i oznaczamy do sprawdzenia.
    update public.receipt_jobs set status = 'error', printer_id = coalesce(p_printer, printer_id), receipt_number = left(p_number, 60),
      printed_at = now(), error = 'Wydrukowany, ale ta sprzedaż ma już inny paragon – sprawdź (możliwy podwójny paragon).' where id = p_id;
  end;
  if j.source <> 'test' then
    insert into public.receipts (source, number, issued_at, pos_order_id, order_id, job_id, currency, items, created_by)
    values ('printer', left(p_number, 60), now(), j.pos_order_id, j.order_id, j.id, 'PLN',
      (select coalesce(jsonb_agg(jsonb_build_object('name', l->>'name', 'quantity', (l->>'qty')::numeric, 'price_brutto', (l->>'price')::numeric,
        'tax_rate', coalesce(nullif(l->>'rate', '')::numeric, case when l->>'ptu' = 'A' then 23 else 0 end), 'ptu', l->>'ptu')), '[]'::jsonb)
       from jsonb_array_elements(j.lines) l),
      j.created_by);
    if j.order_id is not null then
      update public.orders set receipt_at = now() where id = j.order_id;
      perform public.settle_order_units();
    end if;
  end if;
  return 'printed';
end;
$$;
revoke all on function public.finish_receipt_job(uuid, uuid, boolean, text, text) from public, anon, authenticated;
grant execute on function public.finish_receipt_job(uuid, uuid, boolean, text, text) to service_role;

-- 2. Porównanie stanów (główne źródło: Shopify).
create or replace function public.reconcile_stock(
  p_rows jsonb, p_limit int default 300, p_source text default 'Shopify', p_scope uuid[] default null,
  p_confirm_minutes int default 10, p_remove boolean default false, p_surplus_minutes int default 30, p_history_limit int default 50
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_created int := 0;
  v_variants int := 0;
  v_waiting int := 0;
  v_removed int := 0;
  v_kept int := 0;
  v_withdrawn int := 0;
begin
  -- Jeden przebieg naraz (automat i przycisk „Wyrównaj” równocześnie dodałyby sztuki dwa razy).
  perform pg_advisory_xact_lock(hashtext('magazyn:reconcile_stock'));
  if not exists (select 1 from public.sync_state where key = 'initial_stock_imported') then
    return jsonb_build_object('created', 0, 'note', 'czekam na wgranie stanów początkowych');
  end if;

  drop table if exists tmp_src;
  drop table if exists tmp_diff;
  drop table if exists tmp_create;
  drop table if exists tmp_remove;
  create temporary table tmp_src on commit drop as
  select distinct on (variant_id, location_id) variant_id, location_id, qty, count_locs
  from (
    select (r->>'variant_id')::uuid as variant_id, (r->>'location_id')::uuid as location_id, greatest((r->>'qty')::int, 0) as qty,
           coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(r->'count_locations') x), array[(r->>'location_id')::uuid]) as count_locs
    from jsonb_array_elements(p_rows) r
  ) q
  order by variant_id, location_id, qty desc;

  -- diff > 0: brakuje w aplikacji; diff < 0: nadmiar w aplikacji (liczone sztuki na stanie).
  create temporary table tmp_diff on commit drop as
  select b.variant_id, b.location_id, b.count_locs,
         case when b.qty > c.have then b.qty - c.have
              when c.in_stock > b.qty then b.qty - c.in_stock
              else 0 end as diff
  from tmp_src b
  cross join lateral (
    -- Shopify „dostępne” nie liczy zamówionych (zarezerwowanych) – porównujemy ze sztukami na stanie.
    select count(*) filter (where u.status = 'in_stock') as have,
           count(*) filter (where u.status = 'in_stock') as in_stock
    from public.units u where u.variant_id = b.variant_id and u.location_id = any(b.count_locs)
  ) c
  where not exists (
    select 1 from public.unit_events e join public.units u on u.id = e.unit_id
    where u.variant_id = b.variant_id and e.created_at > now() - interval '30 minutes'
  );
  delete from tmp_diff where diff = 0 or (diff < 0 and not p_remove);

  if p_scope is not null then
    delete from public.stock_excess x
    where x.location_id = any(p_scope)
      and not exists (select 1 from tmp_diff d where d.variant_id = x.variant_id and d.location_id = x.location_id);
  end if;
  insert into public.stock_excess (variant_id, location_id, missing, source)
  select variant_id, location_id, diff, p_source from tmp_diff
  on conflict (variant_id, location_id) do update
    set missing = excluded.missing, source = excluded.source, last_seen_at = now(),
        first_seen_at = case when sign(public.stock_excess.missing) <> sign(excluded.missing) then now() else public.stock_excess.first_seen_at end;

  create temporary table tmp_create on commit drop as
  select d.variant_id, d.location_id, d.diff as missing
  from tmp_diff d
  join public.stock_excess x on x.variant_id = d.variant_id and x.location_id = d.location_id
  where d.diff > 0
    and (not exists (select 1 from public.units u where u.variant_id = d.variant_id)
         or x.first_seen_at <= now() - make_interval(mins => greatest(p_confirm_minutes, 0)));

  create temporary table tmp_remove on commit drop as
  select d.variant_id, d.location_id, d.count_locs, -d.diff as surplus
  from tmp_diff d
  join public.stock_excess x on x.variant_id = d.variant_id and x.location_id = d.location_id
  where d.diff < 0 and x.first_seen_at <= now() - make_interval(mins => greatest(p_surplus_minutes, 0));

  select count(*) into v_variants from tmp_create;
  select count(*) - v_variants into v_waiting from tmp_diff where diff > 0;
  if (select coalesce(sum(missing), 0) from tmp_create) > p_limit then
    raise exception '% ma o % sztuk więcej niż aplikacja – to za dużo na automat, sprawdź powiązania magazynów',
      p_source, (select sum(missing) from tmp_create);
  end if;

  with ins as (
    insert into public.units (variant_id, location_id, status, owner_type, purchase_form, notes)
    select m.variant_id, m.location_id, 'in_stock', 'own', 'vat_margin', 'automatycznie: nowy stan w ' || p_source
    from tmp_create m cross join generate_series(1, m.missing)
    returning id
  ), ev as (
    insert into public.unit_events (unit_id, type, data)
    select id, 'received', jsonb_build_object('source', 'automatycznie ze stanu w ' || p_source) from ins
    returning 1
  )
  select count(*) into v_created from ev;

  -- 1) sztuki „bez historii” (tylko licznik stanu) – usuwane bez limitu, najnowsze najpierw
  with cand as (
    select u.id, row_number() over (partition by r.variant_id, r.location_id order by u.received_at desc, u.number desc) as rn, r.surplus
    from tmp_remove r
    join public.units u on u.variant_id = r.variant_id and u.location_id = any(r.count_locs) and u.status = 'in_stock'
    where public.unit_is_plain(u)
  ), del as (
    delete from public.units where id in (select id from cand where rn <= surplus) returning 1
  )
  select count(*) into v_removed from del;

  -- 2) własne sztuki z historią (umowa, dostawa, zwrot) – wycofane ze stanu (status „removed”), historia zostaje;
  --    najwyżej p_history_limit na raz. Komis nigdy automatycznie (oddanie komisantowi to osobna akcja).
  with need as (
    select r.variant_id, r.location_id, r.count_locs,
           greatest(0, (select count(*) from public.units u where u.variant_id = r.variant_id and u.location_id = any(r.count_locs) and u.status = 'in_stock')
                       - coalesce((select qty from tmp_src s where s.variant_id = r.variant_id and s.location_id = r.location_id), 0)) as surplus
    from tmp_remove r
  ), cand2 as (
    select u.id, row_number() over (partition by n.variant_id, n.location_id order by u.received_at desc, u.number desc) as rn, n.surplus
    from need n
    join public.units u on u.variant_id = n.variant_id and u.location_id = any(n.count_locs) and u.status = 'in_stock'
    where u.owner_type = 'own' and n.surplus > 0
  ), pick as (
    select id from cand2 where rn <= surplus order by rn limit greatest(p_history_limit, 0)
  ), upd as (
    update public.units set status = 'removed', notes = trim(both ' ' from coalesce(notes, '') || ' [wycofana: brak na stanie w ' || p_source || ']')
    where id in (select id from pick) returning id
  ), ev as (
    insert into public.unit_events (unit_id, type, data)
    select id, 'removed', jsonb_build_object('reason', 'brak na stanie w ' || p_source) from upd returning 1
  )
  select count(*) into v_withdrawn from ev;
  select greatest(0, coalesce(sum(surplus), 0) - v_removed - v_withdrawn) into v_kept from tmp_remove;

  delete from public.stock_excess x using tmp_create c where x.variant_id = c.variant_id and x.location_id = c.location_id;
  delete from public.stock_excess x using tmp_remove c where x.variant_id = c.variant_id and x.location_id = c.location_id;

  return jsonb_build_object('created', v_created, 'variants', v_variants, 'waiting', v_waiting, 'removed', v_removed, 'withdrawn', v_withdrawn, 'kept', v_kept);
end;
$$;
revoke all on function public.reconcile_stock(jsonb, int, text, uuid[], int, boolean, int, int) from public, anon, authenticated;

-- 3. Czyszczenie katalogu sklepu: bez produktów „nieprzypisanych do Shopify”.
create or replace function public.prune_store_catalog(p_store_id uuid, p_started_at timestamptz)
returns jsonb
language plpgsql
as $$
declare
  v_links int;
  v_products int;
begin
  delete from public.variant_store_links
  where store_id = p_store_id and updated_at < p_started_at;
  delete from public.product_store_links
  where store_id = p_store_id and updated_at < p_started_at;
  get diagnostics v_links = row_count;

  delete from public.products p
  where not p.unassigned
    and not exists (select 1 from public.product_store_links psl where psl.product_id = p.id)
    and not exists (select 1 from public.units u join public.variants v on v.id = u.variant_id where v.product_id = p.id)
    and not exists (select 1 from public.sales s join public.variants v on v.id = s.variant_id where v.product_id = p.id);
  get diagnostics v_products = row_count;

  return jsonb_build_object('removed_links', v_links, 'removed_products', v_products);
end;
$$;

-- 4. Ponowna sprzedaż rzeczy komisanta: po powrocie na stan znacznik „komisant powiadomiony” jest kasowany.
create or replace function public.units_reset_consignor_notified() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.status in ('in_stock', 'in_transit', 'returned') and old.status in ('sold', 'shipped', 'reserved') and new.consignor_notified_at is not null then
    new.consignor_notified_at := null;
  end if;
  return new;
end $$;
drop trigger if exists units_reset_consignor_notified on public.units;
create trigger units_reset_consignor_notified before update of status on public.units
  for each row when (new.owner_type = 'consignment') execute function public.units_reset_consignor_notified();

-- 5a. Historia magazynu: sortowanie po dacie.
create index if not exists unit_events_created_idx on public.unit_events (created_at desc);

-- 5b. Łączenie sprzedaży z zamówieniami (co minutę): numer Base tylko tam, gdzie jest co wpisać.
create or replace function public.link_sales_to_orders()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  update public.sales s
     set order_id = o.id
    from public.orders o
   where s.order_id is null
     and s.order_ref is not null
     and (s.store_id is null or s.store_id = o.store_id)
     and btrim(s.order_ref) in (o.number, o.name, o.shopify_legacy_id);
  get diagnostics n = row_count;

  update public.orders o
     set base_order_id = s.base_order_id
    from public.sales s
   where s.order_id = o.id and o.base_order_id is null and s.base_order_id is not null;
  return n;
end;
$$;
revoke all on function public.link_sales_to_orders() from public, anon, authenticated;

notify pgrst, 'reload schema';
