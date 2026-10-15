# Drukarka Magazyn – program na komputerze przy drukarce fiskalnej (Windows, PowerShell 5.1+).
# Co 2 sekundy pyta aplikację o paragony do wydruku, drukuje je na drukarce fiskalnej i odsyła numer paragonu.
# Ustawienia: config.json obok tego pliku (tworzy je Zainstaluj.bat).

param([switch]$Raz)  # -Raz: jedno sprawdzenie kolejki i koniec (do testów)

$ErrorActionPreference = 'Stop'
$Wersja = '0.3.4'
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
  [DllImport(Dll, CallingConvention = CallingConvention.StdCall)] static extern int DailyReportNumber(out int number);
  [DllImport(Dll, CallingConvention = CallingConvention.StdCall)] static extern int ReadReceiptVisualizationLine(int fiscalReportNumber, int receiptNumber, int readFirst, byte[] buf, uint bufSize, out int isEnd);
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
  /// Numer paragonu w bieżącej dobie fiskalnej (liczony od 1 po każdym raporcie dobowym).
  public static int OstatniNumer() { int n; Ok(ReceiptNumber(out n), "Odczyt numeru paragonu"); return n; }
  public static int OstatniRaport() { int n; Ok(DailyReportNumber(out n), "Odczyt numeru raportu dobowego"); return n; }
  /// Treść paragonu z kopii elektronicznej (linia po linii) – stąd numer wydruku, np. 000001441.
  public static string[] Wizualizacja(int doba, int paragon) {
    var linie = new System.Collections.Generic.List<string>();
    for (int i = 0; i < 400; i++) {
      byte[] b = new byte[256];
      int koniec;
      int kod = ReadReceiptVisualizationLine(doba, paragon, i == 0 ? 1 : 0, b, (uint)b.Length, out koniec);
      if (kod != 0) { if (i == 0) throw new Exception("Odczyt treści paragonu: " + Opis(kod) + " (kod " + kod + ")"); break; }
      if (koniec != 0) break;
      linie.Add(D(b));
    }
    return linie.ToArray();
  }
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

# Adres IP z ustawień: bez spacji, przecinki zamienione na kropki („192,168,1,50” → „192.168.1.50”). $null, gdy to nie jest adres IPv4.
function Popraw-Ip([string]$tekst) {
  $ip = ($tekst -replace '\s', '' -replace ',', '.').Trim('.')
  if ($ip -match '^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$' -and -not ($Matches[1..4] | Where-Object { [int]$_ -gt 255 })) { return $ip }
  return $null
}

# Szukanie drukarki w sieci lokalnej: urządzenia z otwartym portem drukarki (np. 1001) w sieci tego komputera (x.x.x.1–254).
function Znajdz-Drukarke([int]$port) {
  $sieci = @()
  foreach ($k in [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    if ($k.OperationalStatus -ne 'Up' -or $k.NetworkInterfaceType -eq 'Loopback') { continue }
    foreach ($a in $k.GetIPProperties().UnicastAddresses) {
      if ($a.Address.AddressFamily -ne 'InterNetwork') { continue }
      $b = $a.Address.GetAddressBytes()
      if ($b[0] -eq 169 -and $b[1] -eq 254) { continue }
      $sieci += "{0}.{1}.{2}" -f $b[0], $b[1], $b[2]
    }
  }
  $proby = @()
  foreach ($siec in ($sieci | Select-Object -Unique)) {
    foreach ($n in 1..254) {
      $klient = New-Object Net.Sockets.TcpClient
      try { $proby += [pscustomobject]@{ Ip = "$siec.$n"; Klient = $klient; Wynik = $klient.BeginConnect("$siec.$n", $port, $null, $null) } } catch { $klient.Close() }
    }
  }
  Start-Sleep -Milliseconds 2500
  $znalezione = @()
  foreach ($p in $proby) {
    try { if ($p.Wynik.IsCompleted) { $p.Klient.EndConnect($p.Wynik); if ($p.Klient.Connected) { $znalezione += $p.Ip } } } catch {} finally { $p.Klient.Close() }
  }
  return ,$znalezione
}

function Odpowiada([string]$ip, [int]$port) {
  $klient = New-Object Net.Sockets.TcpClient
  try {
    $proba = $klient.BeginConnect($ip, $port, $null, $null)
    if (-not $proba.AsyncWaitHandle.WaitOne(4000)) { return $false }
    $klient.EndConnect($proba)
    return $true
  } catch { return $false } finally { $klient.Close() }
}

# Adres drukarki w sieci. Gdy w ustawieniach jest zły adres albo drukarka zmieniła adres (DHCP), program szuka jej w sieci
# i – jeśli znajdzie dokładnie jedną – zapisuje nowy adres w config.json.
function Adres-Drukarki {
  $port = if ($Ust.drukarka.port) { [int]$Ust.drukarka.port } else { 1001 }
  $wpisany = [string]$Ust.drukarka.ip
  $ip = Popraw-Ip $wpisany
  if ($ip -and (Odpowiada $ip $port)) { return $ip, $port }
  $znalezione = Znajdz-Drukarke $port
  if ($znalezione.Count -eq 1) {
    $Ust.drukarka.ip = $znalezione[0]
    $Ust | ConvertTo-Json -Depth 4 | Set-Content -Path $PlikUstawien -Encoding UTF8
    Zapisz-Dziennik "  Drukarka znaleziona w sieci pod adresem $($znalezione[0]):$port (było: '$wpisany') – zapisano w ustawieniach."
    return $znalezione[0], $port
  }
  $powod = if (-not $ip) { "W ustawieniach programu jest zły adres IP drukarki: '$wpisany'." } else { "Drukarka nie odpowiada pod $($ip):$port." }
  if ($znalezione.Count -gt 1) { throw "$powod W sieci jest kilka urządzeń z portem $($port): $($znalezione -join ', '). Uruchom Zainstaluj.bat ponownie i wybierz adres drukarki." }
  throw "$powod Nie znaleziono drukarki w sieci – sprawdź, czy jest włączona i podłączona do tej samej sieci (Wi-Fi 2,4 GHz / kabel), a adres IP z wydruku Menu -> Raporty -> Stan modułu wpisz, uruchamiając ponownie Zainstaluj.bat."
}

function Polacz-Elzab {
  Zaladuj-Elzab
  $czas = if ($Ust.drukarka.timeout) { [int]$Ust.drukarka.timeout } else { 10 }
  if ($Ust.drukarka.polaczenie -eq 'tcp') {
    $ip, $port = Adres-Drukarki
    [ElzabSterownik]::PolaczTcp($ip, $port, $czas)
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

# Numer wydruku z treści paragonu (9 cyfr, np. 000001441 – ten sam, co na papierze).
# Doba fiskalna paragonu = ostatni raport dobowy + 1 (gdyby się nie udało – sam ostatni raport).
function Numer-Wydruku([int]$paragon) {
  $linie = @()
  $bledy = @()
  $raport = $(try { [ElzabSterownik]::OstatniRaport() } catch { $bledy += "numer raportu dobowego: $(Tresc-Bledu $_)"; $null })
  # Kopia elektroniczna zapisuje się chwilę po wydruku – kilka prób co 1,5 s; doba bieżąca to zwykle „ostatni raport + 1”.
  $doby = @(); if ($null -ne $raport) { $doby += ($raport + 1), $raport }; $doby += 0
  for ($proba = 0; $proba -lt 3 -and -not $linie.Count; $proba++) {
    if ($proba) { Start-Sleep -Milliseconds 1500 }
    foreach ($doba in $doby) {
      if ($doba -lt 0) { continue }
      try { $linie = @([ElzabSterownik]::Wizualizacja([int]$doba, $paragon)); if ($linie.Count) { break } else { $bledy += "doba ${doba}: pusta treść" } }
      catch { $bledy += "doba ${doba}: $(Tresc-Bledu $_)" }
    }
  }
  $numer = $null
  # Numer jak na wydruku. ELZAB: w nagłówku „nr dok.000001453”; inne drukarki: „Nr wydr. 1453”.
  # „#01/KIEROWNIK” w stopce to numer kasy i kasjer – pomijany.
  $tekst = $linie -join "`n"
  foreach ($wzor in @('(?i)nr\s*dok\w*\.?\s*:?\s*(\d{1,9})(?!\d)', '(?i)nr\.?\s*wydr\w*\.?\s*:?\s*(\d{1,9})(?!\d)')) {
    $m = [regex]::Match($tekst, $wzor)
    if ($m.Success -and [int64]$m.Groups[1].Value -gt 0) { $numer = $m.Groups[1].Value.PadLeft(9, '0'); break }
  }
  # Ostatecznie: samodzielne 9 cyfr (bez NIP / telefonu).
  for ($i = $linie.Count - 1; $i -ge 0 -and -not $numer; $i--) {
    $l = [string]$linie[$i]
    if ($l -match '(?i)nip|tel') { continue }
    $m = [regex]::Match($l, '(?<![\d,])(\d{9})(?![\d,.])')
    if ($m.Success) { $numer = $m.Groups[1].Value }
  }
  $opis = if ($linie.Count) { $linie -join "`n" } else { "(nie odczytano treści paragonu nr $paragon w dobie; raport dobowy: $raport)`n" + ($bledy -join "`n") }
  return [pscustomobject]@{ Numer = $numer; Linie = $linie; Opis = $opis }
}

# ELZAB (np. Zeta Online): paragon przez bibliotekę ElzabDR.dll. Zwraca numer wydruku z drukarki (jak na papierze)
# i numer paragonu w dobie.
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
    $wydruk = Numer-Wydruku $numer
    return [pscustomobject]@{ Numer = $(if ($wydruk.Numer) { $wydruk.Numer } else { "$numer" }); Doba = "$numer"; Tresc = $wydruk.Opis; ZWydruku = [bool]$wydruk.Numer }
  } catch {
    $blad = Tresc-Bledu $_
    # Zabezpieczenie przed podwójnym paragonem: jeśli mimo błędu (np. zerwane połączenie przy zamknięciu)
    # numer ostatniego paragonu w drukarce wzrósł, paragon jest wydrukowany.
    if ($otwarty -and $null -ne $przed) {
      $po = $(try { [ElzabSterownik]::OstatniNumer() } catch { $null })
      if ($null -ne $po -and $po -gt $przed) {
        Zapisz-Dziennik "  błąd po zamknięciu ($blad), ale drukarka ma nowy paragon nr $po"
        $wydruk = $(try { Numer-Wydruku $po } catch { [pscustomobject]@{ Numer = $null; Linie = @(); Opis = "$(Tresc-Bledu $_)" } })
        return [pscustomobject]@{ Numer = $(if ($wydruk.Numer) { $wydruk.Numer } else { "$po" }); Doba = "$po"; Tresc = $wydruk.Opis; ZWydruku = [bool]$wydruk.Numer }
      }
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

# ---------- Zgłoszenie wydrukowanego paragonu (nie może zginąć) ----------

$PlikZaleglych = Join-Path $Folder 'niewyslane.json'
$OstatnieZalegle = [datetime]::MinValue

function Kod-Bledu($err) {
  try { return [int]$err.Exception.Response.StatusCode } catch { return 0 }
}

# Odmowa aplikacji (4xx poza złym kluczem 401) – ponawianie nic nie da.
function Blad-Trwaly($err) {
  $k = Kod-Bledu $err
  return ($k -ge 400 -and $k -lt 500 -and $k -ne 401 -and $k -ne 408 -and $k -ne 429)
}

function Zglos-Wydruk($id, $dane) {
  # Paragon już wydrukowany: zgłaszamy do skutku (kilka prób), a gdy aplikacja nie odpowiada – zapis do pliku
  # i ponowienie w kolejnych przebiegach. Nigdy nie zgłaszamy wtedy błędu (to zgubiłoby paragon w aplikacji).
  for ($i = 0; $i -lt 6; $i++) {
    try { $null = Wywolaj-Api 'POST' "/api/drukarka/zadanie/$id" $dane; return $true } catch {
      Zapisz-Dziennik "  nie udało się zgłosić wydruku (próba $($i + 1)): $(Tresc-Bledu $_)"
      if (Blad-Trwaly $_) { Zapisz-Dziennik "  aplikacja odrzuciła zgłoszenie – sprawdź ten paragon w aplikacji (Ustawienia → Drukarka)."; return $false }
      Start-Sleep -Seconds (5 * ($i + 1))
    }
  }
  $lista = @()
  if (Test-Path $PlikZaleglych) { try { $raw = Get-Content $PlikZaleglych -Raw -Encoding UTF8 | ConvertFrom-Json; $lista = @($raw | ForEach-Object { $_ }) } catch { $lista = @() } }
  $lista += [pscustomobject]@{ id = "$id"; dane = $dane; od = (Get-Date).ToString('o') }
  ($lista | ConvertTo-Json -Depth 6) | Set-Content -Path $PlikZaleglych -Encoding UTF8
  Zapisz-Dziennik "  zapisano do ponownego zgłoszenia ($PlikZaleglych)"
  return $false
}

function Wyslij-Zalegle {
  if (-not (Test-Path $PlikZaleglych)) { return }
  # Najwyżej raz na minutę.
  if (((Get-Date) - $script:OstatnieZalegle).TotalSeconds -lt 60) { return }
  $script:OstatnieZalegle = Get-Date
  $lista = @()
  try { $raw = Get-Content $PlikZaleglych -Raw -Encoding UTF8 | ConvertFrom-Json; $lista = @($raw | ForEach-Object { $_ }) } catch { return }
  $zostaje = @()
  foreach ($z in $lista) {
    if ($z.od -and ((Get-Date) - [datetime]$z.od).TotalDays -gt 7) { Zapisz-Dziennik "Porzucono zaległe zgłoszenie paragonu $($z.id) (ponad 7 dni) – sprawdź go w aplikacji." ; continue }
    try { $null = Wywolaj-Api 'POST' "/api/drukarka/zadanie/$($z.id)" $z.dane; Zapisz-Dziennik "Zgłoszono zaległy paragon $($z.id)" }
    catch {
      Zapisz-Dziennik "Zaległy paragon $($z.id): $(Tresc-Bledu $_)"
      if (Blad-Trwaly $_) { Zapisz-Dziennik "  aplikacja odrzuciła zgłoszenie – porzucono, sprawdź ten paragon w aplikacji." }
      else { $zostaje += $z }
    }
  }
  if ($zostaje.Count) { ($zostaje | ConvertTo-Json -Depth 6) | Set-Content -Path $PlikZaleglych -Encoding UTF8 }
  else { Remove-Item $PlikZaleglych -ErrorAction SilentlyContinue }
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
    Wyslij-Zalegle
    $zadanie = Wywolaj-Api 'GET' '/api/drukarka/zadanie' $null
    if ($null -ne $zadanie) {
      Zapisz-Dziennik "Paragon #$($zadanie.number): $($zadanie.lines.Count) poz., $($zadanie.total) PLN"
      try {
        if ($zadanie.source -eq 'test') {
          $wynik = Sprawdz-Polaczenie
          $null = Wywolaj-Api 'POST' "/api/drukarka/zadanie/$($zadanie.id)" @{ ok = $true; number = $wynik }
        } else {
          $w = Drukuj-Paragon $zadanie
          Zapisz-Dziennik "  wydrukowany, nr $($w.Numer) (w dobie: $($w.Doba))"
          if (-not $w.ZWydruku) { Zapisz-Dziennik "  UWAGA: nie odczytano numeru wydruku z treści paragonu – wysłano numer w dobie. Treść: $($w.Tresc)" }
          # Od tej chwili paragon istnieje – błąd zgłoszenia nie jest błędem druku.
          $null = Zglos-Wydruk $zadanie.id @{ ok = $true; number = "$($w.Numer)"; daily = "$($w.Doba)"; printout = [bool]$w.ZWydruku; text = "$($w.Tresc)" }
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
