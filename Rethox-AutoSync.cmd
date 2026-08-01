@echo off
cd /d "%~dp0"
start "Rethox Auto Sync" powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "%~dp0tools\rethox-auto-sync.ps1"
