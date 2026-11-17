@echo off
setlocal
powershell.exe -NoProfile -Command "if (([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 0 } else { exit 1 }"
if errorlevel 1 (
  set "PATENT_START_BAT=%~f0"
  powershell.exe -NoProfile -Command "try { Start-Process -FilePath $env:PATENT_START_BAT -Verb RunAs -ErrorAction Stop } catch { Write-Host 'Administrator access is required to manage PostgreSQL.'; exit 1 }"
  if errorlevel 1 pause
  exit /b
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-project.ps1"
echo.
echo Press any key to close this window.
pause >nul
