# Drukarka Magazyn – program na komputerze przy drukarce fiskalnej (Windows, PowerShell 5.1+).
# Co 2 sekundy pyta aplikację o paragony do wydruku, drukuje je na drukarce fiskalnej i odsyła numer paragonu.
# Ustawienia: config.json obok tego pliku (tworzy je Zainstaluj.bat).

param([switch]$Raz)  # -Raz: jedno sprawdzenie kolejki i koniec (do testów)

$ErrorActionPreference = 'Stop'
$Wersja = '0.2.0'
$Folder = Split-Path -Parent $MyInvocation.MyCommand.Path
$PlikUstawien = Join-Path $Folder 'config.json'
$PlikDziennika = Join-Path $Folder 'dziennik.txt'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Treść błędu bez opakowania PowerShella („Exception calling … with N argument(s)”).
function Tresc-Bledu($err) {
  $e = $err.Exception
  while ($null -ne $e.InnerException) { $e = $e.InnerException }
  return $e.Message
}

function Zapisz-Dziennik([string]$tekst) {
  $linia = "{0:yyyy-MM-dd HH:mm:ss}  {1}" -f (Get-Date), $tekst
  Add-Content -Path $PlikDziennika -Value $linia -Encoding UTF8
  Write-Host $linia
  if ((Get-Item $PlikDziennika).Length -gt 2MB) { Move-Item $PlikDziennika "$PlikDziennika.old" -Force }
}

if (-not (Test-Path $PlikUstawien)) { throw "Brak pliku config.json – uruchom Zainstaluj.bat." }
$Ust = Get-Content $PlikUstawien -Raw -Encoding UTF8 | ConvertFrom-Json
# Klucz drukarki zapisany przez instalator (zaszyfrowany kontem Windows – DPAPI).
$Klucz = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR(($Ust.klucz | ConvertTo-SecureString)))
$Adres = $Ust.adres.TrimEnd('/')
$Naglowki = @{ Authorization = "Bearer $Klucz" }

# ---------- Połączenie z aplikacją ----------

function Wywolaj-Api([string]$metoda, [string]$sciezka, $dane) {
  $parametry = @{ Uri = "$Adres$sciezka"; Method = $metoda; Headers = $Naglowki; UseBasicParsing = $true; TimeoutSec = 30 }
  if ($null -ne $dane) {
    $parametry.Body = [Text.Encoding]::UTF8.GetBytes(($dane | ConvertTo-Json -Depth 6 -Compress))
    $parametry.ContentType = 'application/json; charset=utf-8'
  }
  $odp = Invoke-WebRequest @parametry
  if ($odp.StatusCode -eq 204) { return $null }
  $tekst = [Text.Encoding]::UTF8.GetString($odp.RawContentStream.ToArray())
  if ([string]::IsNullOrWhiteSpace($tekst)) { return $null }
  return $tekst | ConvertFrom-Json
}

# ---------- Połączenie z drukarką ----------

$Elzab = @{ Folder = Join-Path $Folder ('elzab\' + $(if ([Environment]::Is64BitProcess) { 'x64' } else { 'x86' })); Gotowy = $false }

# Biblioteka ELZAB (ElzabDR.dll, licencja freeware ELZAB S.A.) – obsługuje protokół STX drukarek ONLINE (np. Zeta Online).
$KodElzab = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class ElzabSterownik {
  [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool SetDllDirectory(string path);
  [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr LoadLibraryEx(string path, IntPtr file, uint flags);

  const string Dll = "ElzabDR.dll";
  [DllImport(Dll, CallingConvention = CallingConvention.StdCall)] static extern int CommunicationInit(int portNo, int speed, int timeout);
  [DllImport(Dll, CallingConvention = CallingConvention.StdCall)] static extern int CommunicationInit2(byte[] ip, int port, int timeout);
  [DllImport(Dll, CallingConvention = CallingConvention.StdCall)] static extern int CommunicationEnd();
  [DllImport(Dll, CallingConvention = CallingConvention.StdCall)] static extern int ReceiptConditions();
  [DllImport(Dll, CallingConvention = CallingConvention.StdCall)] static extern int ErasePayments();
  [DllImport(Dll, CallingConvention = CallingConvention.StdCall)] static extern int EraseLines();
  [DllImport(Dll, CallingConvention = CallingConvention.StdCall)] static extern int ReceiptBegin();
  [DllImport(Dll, CallingConvention = CallingConvention.StdCall)] static extern int pReceiptItem(int sprzedaz, byte[] nazwa, int stawka, int komunikat, int ilosc, int mp, byte[] jedn, int cena, ref int wartosc);
  [DllImport(Dll, CallingConvention = CallingConvention.StdCall)] static extern int FillPaymentSTX(int number, byte[] name, int total, int change, int kind);
  [DllImport(Dll, CallingConvention = CallingConvention.StdCall)] static extern int ReceiptEnd(int rabat);
  [DllImport(Dll, CallingConvention = CallingConvention.StdCall)] static extern int ReceiptCancel();
  [DllImport(Dll, CallingConvention = CallingConvention.StdCall)] static extern int ReceiptNumber(out int number);
  [DllImport(Dll, CallingConvention = CallingConvention.StdCall)] static extern int pDeviceName(byte[] name);
  [DllImport(Dll, CallingConvention = CallingConvention.StdCall)] static extern int pDllVersion(byte[] ver);
  [DllImport(Dll, CallingConvention = CallingConvention.StdCall)] static extern int pErrMessage(int number, byte[] message);

  // Biblioteka przyjmuje teksty w stronie kodowej Windows-1250 (polskie znaki).
  static Encoding Cp { get { return Encoding.GetEncoding(1250); } }
  static byte[] S(string s) { byte[] b = Cp.GetBytes(s ?? ""); Array.Resize(ref b, b.Length + 1); return b; }
  static string D(byte[] b) { int n = Array.IndexOf(b, (byte)0); if (n < 0) n = b.Length; return Cp.GetString(b, 0, n).Trim(); }

  /// Ładuje ElzabDR.dll z folderu programu (razem z bibliotekami libstdc++/libgcc/libwinpthread obok niej).
  public static void Zaladuj(string folder) {
    if (Environment.OSVersion.Platform != PlatformID.Win32NT) return; // test poza Windows: biblioteka z LD_LIBRARY_PATH
    SetDllDirectory(folder);
    IntPtr h = LoadLibraryEx(Path.Combine(folder, Dll), IntPtr.Zero, 0x8 /* LOAD_WITH_ALTERED_SEARCH_PATH */);
    if (h == IntPtr.Zero) throw new Exception("Nie udało się wczytać " + Path.Combine(folder, Dll) + " (błąd Windows " + Marshal.GetLastWin32Error() + ")");
  }

  public static string Opis(int kod) {
    byte[] b = new byte[1024];
    try { pErrMessage(kod, b); } catch { }
    string s = D(b);
    return s.Length > 0 ? s : "błąd " + kod;
  }
  static void Ok(int kod, string co) { if (kod != 0) throw new Exception(co + ": " + Opis(kod) + " (kod " + kod + ")"); }

  public static void PolaczTcp(string ip, int port, int timeout) { Ok(CommunicationInit2(S(ip), port, timeout), "Połączenie z drukarką " + ip + ":" + port); }
  public static void PolaczCom(int com, int predkosc, int timeout) { Ok(CommunicationInit(com, predkosc, timeout), "Połączenie z drukarką COM" + com); }
  public static void Rozlacz() { try { CommunicationEnd(); } catch { } }
  public static string Nazwa() { byte[] b = new byte[256]; Ok(pDeviceName(b), "Odczyt nazwy drukarki"); return D(b); }
  public static string Wersja() { byte[] b = new byte[256]; try { pDllVersion(b); } catch { } return D(b); }
  /// 0 = można wystawić paragon; inaczej kod powodu (np. brak papieru, otwarta pokrywa, zablokowana drukarka).
  public static int Warunki() { return ReceiptConditions(); }
  public static int OstatniNumer() { int n; Ok(ReceiptNumber(out n), "Odczyt numeru paragonu"); return n; }
  public static void Otworz() { ErasePayments(); EraseLines(); Ok(ReceiptBegin(), "Otwarcie paragonu"); }
  public static void Pozycja(string nazwa, int stawka, int ilosc, int miejsca, string jedn, int cena) {
    int wartosc = 0;
    Ok(pReceiptItem(1, S(nazwa), stawka, 0, ilosc, miejsca, S(jedn), cena, ref wartosc), "Pozycja „" + nazwa + "”");
  }
  /// rodzaj: 1 gotówka, 2 karta, 7 przelew, 9 płatność mobilna (BLIK). Kwoty w groszach.
  public static void Platnosc(string nazwa, int kwota, int rodzaj) { Ok(FillPaymentSTX(1, S(nazwa), kwota, 0, rodzaj), "Płatność " + nazwa); }
  public static void Zamknij() { Ok(ReceiptEnd(0), "Zamknięcie paragonu"); }
  public static void Anuluj() { try { ReceiptCancel(); } catch { } }
}
'@

function Zaladuj-Elzab {
  if ($Elzab.Gotowy) { return }
  if ([Environment]::OSVersion.Platform -eq 'Win32NT' -and -not (Test-Path (Join-Path $Elzab.Folder 'ElzabDR.dll'))) {
    throw "Brak biblioteki ELZAB ($($Elzab.Folder)\ElzabDR.dll) – zainstaluj program ponownie z aplikacji (Ustawienia -> Drukarka fiskalna -> Pobierz program)."
  }
  if ($PSVersionTable.PSVersion.Major -ge 6) { [Text.Encoding]::RegisterProvider([Text.CodePagesEncodingProvider]::Instance) }
  if (-not ('ElzabSterownik' -as [type])) { Add-Type -TypeDefinition $KodElzab -Language CSharp }
  [ElzabSterownik]::Zaladuj($Elzab.Folder)
  $Elzab.Gotowy = $true
}

# Szybkie sprawdzenie, czy drukarka w ogóle odpowiada w sieci (czytelniejszy komunikat niż błąd biblioteki).
function Sprawdz-Siec {
  $klient = New-Object Net.Sockets.TcpClient
  try {
    $proba = $klient.BeginConnect($Ust.drukarka.ip, [int]$Ust.drukarka.port, $null, $null)
    if (-not $proba.AsyncWaitHandle.WaitOne(4000)) { throw "Drukarka nie odpowiada pod $($Ust.drukarka.ip):$($Ust.drukarka.port) – sprawdź, czy jest włączona, Wi-Fi / kabel sieciowy i adres IP." }
    $klient.EndConnect($proba)
  } finally { $klient.Close() }
}

function Polacz-Elzab {
  Zaladuj-Elzab
  $czas = if ($Ust.drukarka.timeout) { [int]$Ust.drukarka.timeout } else { 10 }
  if ($Ust.drukarka.polaczenie -eq 'tcp') {
    Sprawdz-Siec
    [ElzabSterownik]::PolaczTcp([string]$Ust.drukarka.ip, [int]$Ust.drukarka.port, $czas)
  } else {
    $nr = [int](([string]$Ust.drukarka.com) -replace '\D', '')
    if ($nr -le 0) { throw "Zły port COM w config.json: '$($Ust.drukarka.com)'" }
    $predkosc = if ($Ust.drukarka.predkosc) { [int]$Ust.drukarka.predkosc } else { 9600 }
    [ElzabSterownik]::PolaczCom($nr, $predkosc, $czas)
  }
}

function Sprawdz-Polaczenie {
  if ($Ust.drukarka.tryb -eq 'test') { return 'tryb testowy (bez drukarki)' }
  Polacz-Elzab
  try {
    $nazwa = [ElzabSterownik]::Nazwa()
    $warunki = [ElzabSterownik]::Warunki()
    if ($warunki -ne 0) { return "połączenie OK ($nazwa), ale paragonu teraz nie wydrukuje: $([ElzabSterownik]::Opis($warunki))" }
    return "połączenie z drukarką OK ($nazwa)"
  } finally { [ElzabSterownik]::Rozlacz() }
}

# ---------- Sterowniki ----------

# Tryb testowy: nic nie drukuje. Zapisuje podgląd paragonu do pliku – do sprawdzenia całej drogi aplikacja → komputer.
function Drukuj-Test($zadanie) {
  $plik = Join-Path $Folder ("podglad-paragonu-{0}.txt" -f $zadanie.number)
  $linie = @("PODGLĄD PARAGONU (tryb testowy – NIC nie wydrukowano)", "")
  foreach ($l in $zadanie.lines) { $linie += ("{0}  {1} x {2:N2}  PTU {3}" -f $l.name, $l.qty, [double]$l.price, $l.ptu) }
  $linie += ""; $linie += ("SUMA {0:N2} PLN  płatność: {1}" -f [double]$zadanie.total, $zadanie.payment)
  Set-Content -Path $plik -Value $linie -Encoding UTF8
  throw "Program jest w trybie testowym – paragon NIE został wydrukowany (podgląd: $plik). Zmień tryb na 'elzab' w config.json."
}

# Pozycje paragonu w jednostkach drukarki: cena w groszach, ilość bez przecinka + liczba miejsc po przecinku, stawka 1..7 (A..G).
function Pozycje-Elzab($zadanie) {
  $wynik = @()
  foreach ($l in @($zadanie.lines)) {
    $ptu = ([string]$l.ptu).Trim().ToUpper()
    $stawka = 'ABCDEFG'.IndexOf($ptu) + 1
    if ($ptu.Length -ne 1 -or $stawka -lt 1) { throw "Zła stawka PTU '$($l.ptu)' w pozycji '$($l.name)'." }
    $ilosc = [decimal]$l.qty
    if ($ilosc -le 0) { throw "Zła ilość w pozycji '$($l.name)'." }
    $miejsca = if ($ilosc -eq [decimal]::Truncate($ilosc)) { 0 } else { 3 }
    $iloscInt = [int][decimal]::Round($ilosc * [decimal][Math]::Pow(10, $miejsca), 0, [MidpointRounding]::AwayFromZero)
    $cena = [int][decimal]::Round(([decimal]$l.price) * 100, 0, [MidpointRounding]::AwayFromZero)
    if ($cena -le 0) { throw "Pozycja '$($l.name)' ma cenę 0 – drukarka fiskalna nie przyjmie takiej pozycji." }
    $wartosc = [int][decimal]::Round(([decimal]$iloscInt * $cena) / [decimal][Math]::Pow(10, $miejsca), 0, [MidpointRounding]::AwayFromZero)
    $nazwa = ((([string]$l.name) -replace '[\x00-\x1f\x7f]', ' ') -replace '[\u2013\u2014]', '-' -replace '[\u201E\u201D\u201C]', '"').Trim()
    if ($nazwa.Length -gt 40) { $nazwa = $nazwa.Substring(0, 40).Trim() }
    if (-not $nazwa) { $nazwa = 'Towar' }
    $wynik += [pscustomobject]@{ Nazwa = $nazwa; Stawka = $stawka; Ilosc = $iloscInt; Miejsca = $miejsca; Cena = $cena; Wartosc = $wartosc }
  }
  if ($wynik.Count -eq 0) { throw 'Paragon nie ma pozycji.' }
  return ,$wynik
}

$Platnosci = @{ card = @('Karta', 2); transfer = @('Przelew', 7); mobile = @('BLIK', 9) }

# ELZAB (np. Zeta Online): paragon przez bibliotekę ElzabDR.dll. Zwraca numer paragonu z drukarki.
function Drukuj-Elzab($zadanie) {
  $pozycje = Pozycje-Elzab $zadanie
  $suma = 0; foreach ($p in $pozycje) { $suma += $p.Wartosc }
  Polacz-Elzab
  $otwarty = $false
  $przed = $null
  try {
    $przed = $(try { [ElzabSterownik]::OstatniNumer() } catch { $null })
    $warunki = [ElzabSterownik]::Warunki()
    if ($warunki -ne 0) { throw "Drukarka nie może teraz wystawić paragonu: $([ElzabSterownik]::Opis($warunki))" }
    [ElzabSterownik]::Otworz()
    $otwarty = $true
    foreach ($p in $pozycje) { [ElzabSterownik]::Pozycja($p.Nazwa, $p.Stawka, $p.Ilosc, $p.Miejsca, 'szt.', $p.Cena) }
    $pl = $Platnosci[[string]$zadanie.payment]
    if ($pl) { [ElzabSterownik]::Platnosc($pl[0], $suma, $pl[1]) }  # gotówka: domyślna płatność drukarki
    [ElzabSterownik]::Zamknij()
    $otwarty = $false
    $numer = [ElzabSterownik]::OstatniNumer()
    return "$numer"
  } catch {
    $blad = Tresc-Bledu $_
    # Zabezpieczenie przed podwójnym paragonem: jeśli mimo błędu (np. zerwane połączenie przy zamknięciu)
    # numer ostatniego paragonu w drukarce wzrósł, paragon jest wydrukowany.
    if ($otwarty -and $null -ne $przed) {
      $po = $(try { [ElzabSterownik]::OstatniNumer() } catch { $null })
      if ($null -ne $po -and $po -gt $przed) { Zapisz-Dziennik "  błąd po zamknięciu ($blad), ale drukarka ma nowy paragon nr $po"; return "$po" }
    }
    if ($otwarty) { [ElzabSterownik]::Anuluj() }
    throw $blad
  } finally {
    [ElzabSterownik]::Rozlacz()
  }
}

function Drukuj-Paragon($zadanie) {
  switch ($Ust.drukarka.tryb) {
    'test' { return Drukuj-Test $zadanie }
    'elzab' { return Drukuj-Elzab $zadanie }
    default { throw "Nieznany tryb drukarki: $($Ust.drukarka.tryb)" }
  }
}

# ---------- Główna pętla ----------

$mutex = New-Object Threading.Mutex($false, 'Global\DrukarkaMagazyn')
if (-not $mutex.WaitOne(0)) { Write-Host 'Program już działa.'; exit 0 }

Zapisz-Dziennik "Start programu $Wersja · $Adres · tryb $($Ust.drukarka.tryb)"
$ostatniStan = [datetime]::MinValue
while ($true) {
  try {
    if (((Get-Date) - $ostatniStan).TotalSeconds -ge 60) {
      $polaczenie = $(try { Sprawdz-Polaczenie } catch { "błąd: $(Tresc-Bledu $_)" })
      $null = Wywolaj-Api 'POST' '/api/drukarka/stan' @{ wersja = $Wersja; tryb = $Ust.drukarka.tryb; polaczenie = $polaczenie; komputer = $env:COMPUTERNAME }
      $ostatniStan = Get-Date
    }
    $zadanie = Wywolaj-Api 'GET' '/api/drukarka/zadanie' $null
    if ($null -ne $zadanie) {
      Zapisz-Dziennik "Paragon #$($zadanie.number): $($zadanie.lines.Count) poz., $($zadanie.total) PLN"
      try {
        if ($zadanie.source -eq 'test') {
          $wynik = Sprawdz-Polaczenie
          $null = Wywolaj-Api 'POST' "/api/drukarka/zadanie/$($zadanie.id)" @{ ok = $true; number = $wynik }
        } else {
          $numer = Drukuj-Paragon $zadanie
          $null = Wywolaj-Api 'POST' "/api/drukarka/zadanie/$($zadanie.id)" @{ ok = $true; number = "$numer" }
          Zapisz-Dziennik "  wydrukowany, nr $numer"
        }
      } catch {
        $blad = Tresc-Bledu $_
        Zapisz-Dziennik "  BŁĄD: $blad"
        try { $null = Wywolaj-Api 'POST' "/api/drukarka/zadanie/$($zadanie.id)" @{ ok = $false; error = $blad } } catch { Zapisz-Dziennik "  nie udało się zgłosić błędu: $($_.Exception.Message)" }
      }
      continue
    }
  } catch {
    Zapisz-Dziennik "Brak połączenia z aplikacją: $($_.Exception.Message)"
    Start-Sleep -Seconds 10
  }
  if ($Raz) { break }
  Start-Sleep -Seconds 2
}
