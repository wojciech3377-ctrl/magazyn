# Instalator programu „Drukarka Magazyn”: kopiuje program, pyta o klucz drukarki i połączenie, ustawia autostart.
$ErrorActionPreference = 'Stop'
$Zrodlo = Split-Path -Parent $MyInvocation.MyCommand.Path
$Cel = Join-Path $env:LOCALAPPDATA 'DrukarkaMagazyn'
New-Item -ItemType Directory -Force -Path $Cel | Out-Null
Copy-Item (Join-Path $Zrodlo 'DrukarkaMagazyn.ps1') $Cel -Force
$Szablon = Get-Content (Join-Path $Zrodlo 'adres.txt') -Raw -Encoding UTF8

Write-Host ''
Write-Host '=== Drukarka Magazyn – instalacja ===' -ForegroundColor Cyan
Write-Host 'Klucz drukarki znajdziesz w aplikacji: Ustawienia -> Drukarka fiskalna -> Dodaj drukarkę.'
$klucz = Read-Host 'Wklej klucz drukarki (zaczyna się od drk_)' -AsSecureString

Write-Host ''
Write-Host 'Jak drukarka jest podłączona do tego komputera?'
Write-Host '  1 - przez sieć (Wi-Fi / kabel sieciowy) - zalecane'
Write-Host '  2 - kablem USB (port COM)'
$wybor = Read-Host 'Wybierz 1 albo 2'
$drukarka = [ordered]@{ tryb = 'test' }
if ($wybor -eq '2') {
  $porty = [IO.Ports.SerialPort]::GetPortNames()
  Write-Host ("Porty COM w tym komputerze: {0}" -f ($porty -join ', '))
  $drukarka.polaczenie = 'com'
  $drukarka.com = Read-Host 'Port drukarki (np. COM3)'
  $pr = Read-Host 'Prędkość portu [9600]'
  $drukarka.predkosc = if ($pr) { [int]$pr } else { 9600 }
} else {
  $drukarka.polaczenie = 'tcp'
  $drukarka.ip = Read-Host 'Adres IP drukarki (w drukarce: Menu -> Raporty -> Stan modułu)'
  $port = Read-Host 'Port TCP drukarki [1001]'
  $drukarka.port = if ($port) { [int]$port } else { 1001 }
}
Write-Host ''
Write-Host 'Tryb pracy: test = nic nie drukuje, tylko sprawdza połączenie i zapisuje podgląd paragonu do pliku.'
$tryb = Read-Host 'Tryb (test / elzab) [test]'
if ($tryb -eq 'elzab') { $drukarka.tryb = 'elzab' }

$ust = [ordered]@{ adres = $Szablon.Trim(); klucz = ($klucz | ConvertFrom-SecureString); drukarka = $drukarka }
$ust | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $Cel 'config.json') -Encoding UTF8

# Autostart po zalogowaniu (ukryte okno) i uruchomienie od razu.
$skrypt = Join-Path $Cel 'DrukarkaMagazyn.ps1'
$akcja = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$skrypt`""
$wyzwalacz = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$opcje = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'Drukarka Magazyn' -Action $akcja -Trigger $wyzwalacz -Settings $opcje -Force | Out-Null
Stop-ScheduledTask -TaskName 'Drukarka Magazyn' -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName 'Drukarka Magazyn'

Write-Host ''
Write-Host "Gotowe. Program działa w tle i uruchamia się sam po zalogowaniu do Windows." -ForegroundColor Green
Write-Host "Folder programu i dziennik: $Cel"
Write-Host 'W aplikacji (Ustawienia -> Drukarka fiskalna) za minutę zobaczysz, że drukarka jest połączona.'
Read-Host 'Naciśnij Enter, aby zamknąć'
