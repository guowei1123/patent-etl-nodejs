@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-and-clone.ps1"
echo.
echo Press any key to close this window.
pause >nul
