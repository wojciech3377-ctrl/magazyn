# Magazyn – sztuki z umowami (etap 1)

Aplikacja dla Telefoniki i Sneakers Depot: każda sztuka towaru to osobna pozycja z umową (albo „bez umowy”).
Base zostaje systemem zamówień i stanów. Aplikacja:

- pobiera katalog z obu sklepów Shopify (nowe produkty dochodzą same przez webhooki),
- przy przyjęciu dostawy tworzy sztuki, drukuje etykiety i podnosi stan w Base (Base aktualizuje sklepy),
- co 5 minut czyta zamówienia z Base i oznacza sprzedane sztuki: najpierw własne, potem komis, zawsze od najstarszej;
  przy pakowaniu sztukę można zmienić skanem kodu z etykiety albo IMEI.

Stos: Next.js 16, Supabase (Postgres, logowanie, pliki), Vercel.

## Uruchomienie

1. **Supabase** → SQL Editor: wklej i uruchom `supabase/migrations/0001_init.sql`, potem `0002_base_links.sql`.
2. **Supabase** → Authentication → Sign In / Providers: wyłącz „Allow new users to sign up”.
   Pierwsze konto dodaj w Authentication → Users → Add user (zostanie administratorem). Kolejne konta dodajesz w aplikacji (Ustawienia).
3. **Shopify** (każdy sklep osobno): Dev Dashboard → aplikacja z uprawnieniami `read_products`, `read_inventory`,
   zainstalowana w sklepie. Client ID i Secret wpisz w Vercel.
4. **Base**: Konto i inne → Moje konto → API → token. Wpisz w Vercel.
5. **Vercel**: import repozytorium, zmienne z `.env.example`, Deploy.
6. W aplikacji: Ustawienia (domeny sklepów, katalog Base, lokalizacje z magazynami Base) → Katalog (import z Shopify,
   katalog Base + powiązania) → Ustawienia → „Wgraj stany z Base”.
7. **Supabase** → SQL Editor: `supabase/cron.sql` (odczyt zamówień co 5 minut).

## Testy bazy

`supabase/tests/run.sh` – schemat i logika magazynu na lokalnym Postgresie (FIFO, zwroty, zamiana sztuki, RLS, powiązania z Base, import stanów).
