#!/usr/bin/env bash
# Agent kamera yang tersambung ke API di Render (atau server jarak jauh lain).
# Hari lomba: npm run agent:render (latar, hidup lagi otomatis bila mati),
#             npm run agent:render:logs, npm run agent:render:stop.
# Pengaturan kamera dari .env, lalu .env.render menimpa alamat API, token,
# dan mode unggah. API/MongoDB lokal tidak dijalankan.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Render menyetel RENDER=true di server — agent butuh kamera, jadi tempatnya di laptop lokasi.
if [ -n "${RENDER:-}" ]; then
  echo "Skrip ini dijalankan di LAPTOP KAMERA, bukan di server Render." >&2
  echo "Di Shell Render cukup buat token agent:" >&2
  echo "  npm run token:device -w api -- agent \"Kamera Finish\"" >&2
  echo "lalu tempel token itu ke .env.render di laptop kamera." >&2
  exit 1
fi
source "$ROOT/scripts/lib-env.sh"
load_env "$ROOT/.env" || true
if ! load_env "$ROOT/.env.render"; then
  echo "File .env.render belum ada — lihat docs/PANDUAN-RENDER.md bagian 4.1" >&2
  exit 1
fi
if [ -z "${PF_DEVICE_TOKEN:-}" ]; then
  echo "PF_DEVICE_TOKEN di .env.render masih kosong — buat token di Shell Render:" >&2
  echo "  npm run token:device -w api -- agent \"Kamera Finish\"" >&2
  exit 1
fi
# --check-config: cukup pastikan .env.render lengkap (dipakai saat memasang autostart).
if [ "${1:-}" = "--check-config" ]; then
  echo "Konfigurasi lengkap: agent kamera → $PF_API_URL"
  exit 0
fi
# Satu kamera = satu agent: agent lokal (npm run dev:local / prod:start) merebut kamera yang sama.
# Tunggu sebentar — agent yang baru dihentikan (pm2 delete) butuh waktu untuk menutup kamera.
for _ in $(seq 1 20); do
  pgrep -f "agent/.venv/bin/pf-agent" >/dev/null || break
  sleep 0.5
done
if pgrep -f "agent/.venv/bin/pf-agent" >/dev/null; then
  echo "Agent kamera lain sedang berjalan (mis. npm run dev:local). Hentikan dulu — satu kamera hanya untuk satu agent." >&2
  exit 1
fi
if [ "${1:-}" = "--check" ]; then
  echo "Siap: agent kamera → $PF_API_URL"
  exit 0
fi
echo "Agent kamera → $PF_API_URL"
# Mac tidak tidur selama agent berjalan (caffeinate ikut berhenti saat proses ini selesai).
if command -v caffeinate >/dev/null; then
  caffeinate -i -w $$ &
fi
cd "$ROOT/agent"
exec .venv/bin/pf-agent -v
