# Instalator programu „Drukarka Magazyn”: kopiuje program, pyta o klucz drukarki i połączenie, ustawia autostart.
$ErrorActionPreference = 'Stop'
$Zrodlo = Split-Path -Parent $MyInvocation.MyCommand.Path
$Cel = Join-Path $env:LOCALAPPDATA 'DrukarkaMagazyn'
New-Item -ItemType Directory -Force -Path $Cel | Out-Null
Copy-Item (Join-Path $Zrodlo 'DrukarkaMagazyn.ps1') $Cel -Force
# Biblioteka drukarek ELZAB (ElzabDR.dll + biblioteki pomocnicze, wersje 64- i 32-bitowa).
if (Test-Path (Join-Path $Zrodlo 'elzab')) { Copy-Item (Join-Path $Zrodlo 'elzab') $Cel -Recurse -Force }
# Program działa w tle – zatrzymaj starą wersję, żeby można było podmienić pliki.
Stop-ScheduledTask -TaskName 'Drukarka Magazyn' -ErrorAction SilentlyContinue
$Szablon = Get-Content (Join-Path $Zrodlo 'adres.txt') -Raw -Encoding UTF8

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


Write-Host ''
Write-Host '=== Drukarka Magazyn – instalacja ===' -ForegroundColor Cyan
Write-Host 'Klucz drukarki znajdziesz w aplikacji: Ustawienia -> Drukarka fiskalna -> Dodaj drukarkę.'
$klucz = Read-Host 'Wklej klucz drukarki (zaczyna się od drk_)' -AsSecureString

Write-Host ''
Write-Host 'Jak drukarka jest podłączona do tego komputera?'
Write-Host '  1 - przez sieć (Wi-Fi / kabel sieciowy) - zalecane'
Write-Host '  2 - kablem USB (port COM)'
$wybor = Read-Host 'Wybierz 1 albo 2'
$drukarka = [ordered]@{ tryb = 'elzab' }
if ($wybor -eq '2') {
  $porty = [IO.Ports.SerialPort]::GetPortNames()
  Write-Host ("Porty COM w tym komputerze: {0}" -f ($porty -join ', '))
  $drukarka.polaczenie = 'com'
  $drukarka.com = Read-Host 'Port drukarki (np. COM3)'
  $pr = Read-Host 'Prędkość portu [9600]'
  $drukarka.predkosc = if ($pr) { [int]$pr } else { 9600 }
} else {
  $drukarka.polaczenie = 'tcp'
  $port = Read-Host 'Port TCP drukarki [1001]'
  $drukarka.port = if ($port -match '^\d+$') { [int]$port } else { 1001 }
  $drukarka.ip = $null
  while (-not $drukarka.ip) {
    Write-Host 'Adres IP drukarki znajdziesz na wydruku: w drukarce Menu -> Raporty -> Stan modułu (np. 192.168.1.50).'
    $wpis = Read-Host 'Adres IP drukarki (Enter = znajdź drukarkę w sieci automatycznie)'
    if (-not $wpis.Trim()) {
      Write-Host 'Szukam drukarki w sieci...'
      $znalezione = Znajdz-Drukarke $drukarka.port
      if ($znalezione.Count -eq 0) { Write-Host "Nie znaleziono w sieci urządzenia z portem $($drukarka.port). Sprawdź, czy drukarka jest włączona i w tej samej sieci, albo wpisz adres ręcznie." -ForegroundColor Yellow; continue }
      if ($znalezione.Count -eq 1) { $drukarka.ip = $znalezione[0]; Write-Host "Znaleziono drukarkę: $($znalezione[0])" -ForegroundColor Green; continue }
      Write-Host 'Znaleziono kilka urządzeń:'
      for ($i = 0; $i -lt $znalezione.Count; $i++) { Write-Host ("  {0} - {1}" -f ($i + 1), $znalezione[$i]) }
      $nr = Read-Host 'Wybierz numer drukarki'
      if ($nr -match '^\d+$' -and [int]$nr -ge 1 -and [int]$nr -le $znalezione.Count) { $drukarka.ip = $znalezione[[int]$nr - 1] }
      continue
    }
    $ip = Popraw-Ip $wpis
    if (-not $ip) { Write-Host "'$wpis' to nie jest adres IP – wpisz cztery liczby oddzielone kropkami, np. 192.168.1.50." -ForegroundColor Yellow; continue }
    if (Odpowiada $ip $drukarka.port) { Write-Host "Drukarka odpowiada pod $($ip):$($drukarka.port)." -ForegroundColor Green; $drukarka.ip = $ip; continue }
    Write-Host "Pod $($ip):$($drukarka.port) nic nie odpowiada." -ForegroundColor Yellow
    if ((Read-Host 'Zapisać ten adres mimo to? (t/n) [n]') -eq 't') { $drukarka.ip = $ip }
  }
}
Write-Host ''
Write-Host 'Tryb pracy:'
Write-Host '  elzab = drukuje paragony fiskalne na drukarce ELZAB (np. Zeta Online)'
Write-Host '  test  = nic nie drukuje, tylko zapisuje podgląd paragonu do pliku'
$tryb = Read-Host 'Tryb (elzab / test) [elzab]'
if ($tryb -eq 'test') { $drukarka.tryb = 'test' }

$ust = [ordered]@{ adres = $Szablon.Trim(); klucz = ($klucz | ConvertFrom-SecureString); drukarka = $drukarka }
$ust | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $Cel 'config.json') -Encoding UTF8

# Autostart po zalogowaniu (ukryte okno), uruchomienie od razu i strażnik: co 5 minut Harmonogram zadań sprawdza,
# czy program działa – jeśli ktoś go zamknął albo się wyłączył, uruchamia go ponownie (drugiej kopii nie tworzy).
$skrypt = Join-Path $Cel 'DrukarkaMagazyn.ps1'
$akcja = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$skrypt`""
$wyzwalacze = @(
  (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME),
  (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650))
)
$opcje = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'Drukarka Magazyn' -Action $akcja -Trigger $wyzwalacze -Settings $opcje -Force | Out-Null
Stop-ScheduledTask -TaskName 'Drukarka Magazyn' -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName 'Drukarka Magazyn'

Write-Host ''
Write-Host "Gotowe. Program działa w tle, uruchamia się sam po zalogowaniu do Windows i wraca sam, gdyby się zamknął." -ForegroundColor Green
Write-Host "Folder programu i dziennik: $Cel"
Write-Host 'W aplikacji (Ustawienia -> Drukarka fiskalna) za minutę zobaczysz, że drukarka jest połączona.'
Read-Host 'Naciśnij Enter, aby zamknąć'
