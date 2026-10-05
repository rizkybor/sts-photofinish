#!/bin/bash
# Dibuka otomatis saat login (Login Item, dipasang lewat `npm run agent:autostart:on`).
# Lewat Terminal — bukan launchd — karena izin kamera macOS diberikan ke aplikasi
# Terminal; proses yang dinyalakan launchd saat boot tidak boleh membuka kamera.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null
cd "$(dirname "$0")/.." || exit 1
echo "STS Photo Finish — menyalakan agent kamera…"
if npm run --silent agent:render; then
  echo
  echo "Agent kamera berjalan di latar. Jendela ini boleh ditutup."
else
  echo
  echo "Agent kamera GAGAL dinyalakan — baca pesan di atas."
fi
