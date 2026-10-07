@echo off
rem HMIS Print - installer. Double-click this file.
title HMIS Print - install
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
