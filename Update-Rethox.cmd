@echo off
cd /d "%~dp0"
start "Rethox Publisher" powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "%~dp0tools\publish-rethox-gui.ps1"
