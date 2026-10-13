-- 0048: faktury sprzedaży w serii FM – następna faktura w 2026 r. to FM/113/2026 (potem FM/114/2026…).
insert into public.invoice_counters (series, year, last) values ('FM', 2026, 112)
on conflict (series, year) do update set last = greatest(public.invoice_counters.last, 112);
