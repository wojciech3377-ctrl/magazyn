# Magazyn – sztuki z umowami

Aplikacja dla Telefoniki i Sneakers Depot. Źródłem prawdy jest Shopify → aplikacja (bez Base):

- katalog i stany z obu sklepów Shopify (na żywo przez webhooki, co minutę zmienione stany, co 10 min pełne porównanie),
- zamówienia ze Shopify na żywo (webhooki + odczyt ostatnich zamówień, gdy aplikacja jest otwarta + co minutę),
- każda sztuka to osobna pozycja z umową (albo „bez umowy”); sprzedaż bierze najpierw własne, potem komis, od najstarszej,
- Kasa, paragony fiskalne (program „Drukarka Magazyn” na Windows), faktury i KSeF, JPK, komis z panelem komisanta.

Stos: Next.js 16, Supabase (Postgres, logowanie, pliki), Vercel (region fra1 – Supabase najlepiej też we Frankfurcie).

## Uruchomienie

1. **Supabase** → SQL Editor: migracje z `supabase/migrations` po kolei.
2. **Supabase** → Authentication → Sign In / Providers: wyłącz „Allow new users to sign up”.
   Pierwsze konto dodaj w Authentication → Users → Add user (zostanie administratorem). Kolejne konta dodajesz w aplikacji (Ustawienia).
3. **Shopify** (każdy sklep osobno): Dev Dashboard → aplikacja z uprawnieniami produktów, zamówień i stanów,
   zainstalowana w sklepie. Client ID i Secret wpisz w Vercel.
4. **Vercel**: import repozytorium, zmienne z `.env.example`, Deploy.
5. W aplikacji: Ustawienia → Sklepy i lokalizacje (domeny, „Na żywo ze Shopify” – webhooki) → Stany magazynowe (lokalizacje Shopify).
6. **Supabase** → SQL Editor: `supabase/cron.sql` (zamówienia i stany co minutę, katalog co 10 minut).

## Testy bazy

`supabase/tests/run.sh` – schemat i logika magazynu na lokalnym Postgresie (FIFO, zwroty, zamiana sztuki, RLS, paragony, przesunięcia, Kasa).
