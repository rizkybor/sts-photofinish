@echo off
rem Agent kamera STS Photo Finish. Biarkan jendela ini terbuka selama lomba
rem (boleh di-minimize). Agent dinyalakan lagi otomatis bila berhenti.
title STS Photo Finish - Agent Kamera
cd /d "%~dp0..\.."
set PYTHONUTF8=1
if not exist "agent\.venv\Scripts\pf-agent.exe" (echo Jalankan scripts\windows\pasang.bat dulu. & pause & exit /b 1)
if not exist ".env.render" (echo File .env.render belum ada - jalankan pasang.bat. & pause & exit /b 1)
:ulang
echo [%date% %time%] Menyalakan agent kamera...
"agent\.venv\Scripts\pf-agent.exe" --env-file ".env.render"
if %errorlevel%==3 (
  echo Agent kamera lain sudah berjalan di komputer ini - jendela ini ditutup.
  timeout /t 10 >nul
  exit /b 0
)
echo [%date% %time%] Agent berhenti (kode %errorlevel%) - dinyalakan lagi dalam 5 detik. Tutup jendela ini untuk berhenti.
timeout /t 5 /nobreak >nul
goto ulang
