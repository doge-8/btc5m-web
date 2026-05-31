@echo off
REM Double-click this file to start the tunnel (no need to change the Windows execution policy)
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tunnel-arl-t4.ps1"
pause
