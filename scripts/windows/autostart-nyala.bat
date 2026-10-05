@echo off
rem Agent kamera menyala otomatis setiap login Windows (jendela ter-minimize).
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup')+'\STS Photo Finish Agent.lnk'); $s.TargetPath='%~dp0jalankan.bat'; $s.WorkingDirectory='%~dp0'; $s.WindowStyle=7; $s.Save()" || (echo GAGAL & pause & exit /b 1)
echo Autostart AKTIF: agent kamera menyala otomatis setiap login ke Windows ini.
pause
