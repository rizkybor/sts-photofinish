#!/bin/bash
# Agent kamera STS Photo Finish (Mac). Dibuka otomatis saat login bila autostart
# aktif (bash scripts/agent-autostart.sh on). Biarkan jendela ini terbuka
# selama lomba (boleh di-minimize); agent dinyalakan lagi otomatis bila berhenti.
# Lewat Terminal — bukan launchd — karena izin kamera macOS diberikan ke Terminal.
cd "$(dirname "$0")/.." || exit 1
printf '\033]0;STS Photo Finish — Agent Kamera\007'
if [ ! -x agent/.venv/bin/pf-agent ]; then echo "Jalankan dulu: bash scripts/pasang-agent-mac.sh"; exit 1; fi
if [ ! -f .env.render ]; then echo "File .env.render belum ada — jalankan bash scripts/pasang-agent-mac.sh"; exit 1; fi
while true; do
  echo "[$(date '+%H:%M:%S')] Menyalakan agent kamera…"
  agent/.venv/bin/pf-agent --env-file .env.render
  code=$?
  if [ "$code" = 3 ]; then
    echo "Agent kamera lain sudah berjalan di Mac ini — jendela ini boleh ditutup."
    exit 0
  fi
  echo "[$(date '+%H:%M:%S')] Agent berhenti (kode $code) — dinyalakan lagi dalam 5 detik. Tutup jendela ini untuk berhenti."
  sleep 5
done
