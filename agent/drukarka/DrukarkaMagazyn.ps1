# Drukarka Magazyn – program na komputerze przy drukarce fiskalnej (Windows, PowerShell 5.1+).
# Co 2 sekundy pyta aplikację o paragony do wydruku, drukuje je na drukarce fiskalnej i odsyła numer paragonu.
# Ustawienia: config.json obok tego pliku (tworzy je Zainstaluj.bat).

param([switch]$Raz)  # -Raz: jedno sprawdzenie kolejki i koniec (do testów)

$ErrorActionPreference = 'Stop'
$Wersja = '0.1.0'
$Folder = Split-Path -Parent $MyInvocation.MyCommand.Path
$PlikUstawien = Join-Path $Folder 'config.json'
$PlikDziennika = Join-Path $Folder 'dziennik.txt'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

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

function Otworz-Drukarke {
  if ($Ust.drukarka.polaczenie -eq 'tcp') {
    $klient = New-Object Net.Sockets.TcpClient
    $proba = $klient.BeginConnect($Ust.drukarka.ip, [int]$Ust.drukarka.port, $null, $null)
    if (-not $proba.AsyncWaitHandle.WaitOne(4000)) { $klient.Close(); throw "Drukarka nie odpowiada pod $($Ust.drukarka.ip):$($Ust.drukarka.port) – sprawdź Wi-Fi / kabel sieciowy i adres IP." }
    $klient.EndConnect($proba)
    $strumien = $klient.GetStream()
    $strumien.ReadTimeout = 15000
    $strumien.WriteTimeout = 5000
    return @{ Typ = 'tcp'; Klient = $klient; Strumien = $strumien }
  }
  $port = New-Object IO.Ports.SerialPort $Ust.drukarka.com, ([int]$Ust.drukarka.predkosc), 'None', 8, 'One'
  $port.ReadTimeout = 15000
  $port.WriteTimeout = 5000
  $port.Open()
  return @{ Typ = 'com'; Port = $port; Strumien = $port.BaseStream }
}

function Zamknij-Drukarke($p) {
  if ($null -eq $p) { return }
  if ($p.Typ -eq 'tcp') { $p.Klient.Close() } else { $p.Port.Close() }
}

function Sprawdz-Polaczenie {
  if ($Ust.drukarka.tryb -eq 'test') { return 'tryb testowy (bez drukarki)' }
  $p = $null
  try { $p = Otworz-Drukarke; return 'połączenie z drukarką OK' } finally { Zamknij-Drukarke $p }
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

# ELZAB (protokół STX): ramki rozkazów paragonu zostaną uzupełnione na podstawie dokumentacji protokołu dla modelu drukarki.
function Drukuj-Elzab($zadanie) {
  throw "Sterownik ELZAB nie jest jeszcze gotowy – czeka na dokumentację protokołu dla Twojego modelu drukarki. Paragon NIE został wydrukowany."
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
      $polaczenie = $(try { Sprawdz-Polaczenie } catch { "błąd: $($_.Exception.Message)" })
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
        $blad = $_.Exception.Message
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
