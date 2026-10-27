@echo off
rem HMIS Lab Bridge - capture mode. Double-click this file.
title HMIS Lab Bridge - capture
rem Windows Firewall blocks an analyser from connecting in, so the port is opened once. That needs
rem administrator rights: ask for them, then carry on in the elevated window.
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell.exe -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
set PORT=5100
if not "%~1"=="" set PORT=%~1
netsh advfirewall firewall delete rule name="HMIS Lab Bridge capture" >nul 2>&1
netsh advfirewall firewall add rule name="HMIS Lab Bridge capture" dir=in action=allow protocol=TCP localport=%PORT% >nul
"%~dp0node.exe" "%~dp0capture.mjs" --port %PORT% --dir "%~dp0captures"
echo.
pause
