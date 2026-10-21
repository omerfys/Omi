@echo off
title Omi - AI Desktop Assistant
echo ===================================================
echo   Omi (Yapay Zeka Masaustu Asistani) Baslatiliyor
echo ===================================================
set "PATH=%USERPROFILE%\.cargo\llvm-mingw-20261006-ucrt-x86_64\bin;%USERPROFILE%\.cargo\bin;%PATH%"
cd /d "%~dp0windows"
echo [Bilgi] Eski ornekler ve port 1420 temizleniyor...
taskkill /f /im omi.exe >nul 2>&1
taskkill /f /im coucou.exe >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr :1420 ^| findstr LISTENING') do taskkill /f /pid %%a >nul 2>&1

echo [Bilgi] Omi baslatiliyor...
call npm run tauri dev
pause
