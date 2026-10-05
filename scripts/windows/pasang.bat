@echo off
rem Pasang agent kamera STS Photo Finish di komputer garis finish (sekali saja).
setlocal
cd /d "%~dp0..\.."
echo === STS Photo Finish - pasang agent kamera ===
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY where python >nul 2>nul && set "PY=python"
if not defined PY (
  echo Python belum terpasang. Unduh Python 3.12 dari https://www.python.org/downloads/
  echo dan centang "Add python.exe to PATH" saat memasang. Lalu jalankan pasang.bat lagi.
  pause & exit /b 1
)
if not exist "agent\.venv\Scripts\pf-agent.exe" (
  echo Memasang agent ^(beberapa menit, butuh internet^)...
  %PY% -m venv agent\.venv || goto :gagal
  agent\.venv\Scripts\python -m pip install -q --upgrade pip
  agent\.venv\Scripts\python -m pip install -q -e agent || goto :gagal
)
echo Agent terpasang.
if not exist ".env.render" copy ".env.render.example" ".env.render" >nul
echo.
echo Langkah berikutnya: isi PF_DEVICE_TOKEN di .env.render (Notepad terbuka), simpan,
echo lalu jalankan scripts\windows\jalankan.bat
notepad ".env.render"
pause
exit /b 0
:gagal
echo GAGAL memasang agent - periksa koneksi internet lalu ulangi.
pause
exit /b 1
