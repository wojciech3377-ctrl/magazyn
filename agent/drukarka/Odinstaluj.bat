@echo off
rem Usuniecie programu Drukarka Magazyn
powershell -NoProfile -Command "Stop-ScheduledTask -TaskName 'Drukarka Magazyn' -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName 'Drukarka Magazyn' -Confirm:$false -ErrorAction SilentlyContinue; Remove-Item -Recurse -Force '%LOCALAPPDATA%\DrukarkaMagazyn' -ErrorAction SilentlyContinue"
echo Program usuniety.
pause
